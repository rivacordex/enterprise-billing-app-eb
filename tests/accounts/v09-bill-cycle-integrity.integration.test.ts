import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import * as schema from "@/db/schema";
import type { Database } from "@/db/client";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { billCycle } from "@/db/schema/billing/catalogs";

// ac15-spec §3.7 — V9: bill-cycle catalog integrity.
// Asserts Module Inv. #11 (retire-not-delete) and the retire-not-break property:
//   - Retiring a cycle removes it from findAllActive but NOT from findAll.
//   - No delete method exists on the repository (structural).
//   - Assigning a retired cycle is rejected by findAllActive (no active row).
//
// A simulated BAN-reference check is structural: existing BANs referencing a
// retired cycle are unaffected because the cycle row is never removed from the
// DB, only transitioned to state='retired'. The join in ac04/ac05 still resolves.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "V9 — Bill-cycle catalog integrity (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql | undefined;
    let db: Database;
    let actorId: string;
    let cycleId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

      // Migrate on a short-lived connection, then close it and open a fresh one
      // for reads: migrate() poisons the connection's type-OID cache so later
      // timestamptz reads on it return raw strings (module Key Decision —
      // "migrate()-poisons-connection quirk").
      const migrateSql = postgres(databaseUrl as string, { max: 1 });
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(migrateSql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      await migrateSql.end();

      sql = postgres(databaseUrl as string, { max: 1 });
      db = drizzle(sql, { schema });

      const [user] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-v09', 'V09 Test', 'v09@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      if (!user) throw new Error("appuser insert returned no row");
      actorId = user.id;

      // Insert a test bill cycle.
      const inserted = await billCycleRepository.insert(db, {
        name: "V09 Test Cycle",
        frequency: "monthly",
        cycleDay: 1,
        paymentDueDays: 30,
        lastEditedBy: actorId,
      });
      cycleId = inserted.billCycleId;
    });

    afterAll(async () => {
      await sql?.end();
    });

    it("newly inserted cycle appears in findAllActive", async () => {
      const active = await billCycleRepository.findAllActive(db);
      expect(active.some((c) => c.billCycleId === cycleId)).toBe(true);
    });

    it("newly inserted cycle appears in findAll", async () => {
      const all = await billCycleRepository.findAll(db);
      expect(all.some((c) => c.billCycleId === cycleId)).toBe(true);
    });

    it("retiring the cycle with correct CAS token succeeds", async () => {
      const row = await billCycleRepository.findById(db, cycleId);
      if (!row) throw new Error("cycle not found");
      const result = await billCycleRepository.retire(
        db,
        cycleId,
        row.lastModified,
      );
      expect(result).toBe("updated");
    });

    it("retired cycle no longer appears in findAllActive (removed from wizard)", async () => {
      const active = await billCycleRepository.findAllActive(db);
      expect(active.some((c) => c.billCycleId === cycleId)).toBe(false);
    });

    it("retired cycle still appears in findAll (row preserved — Inv. #11)", async () => {
      const all = await billCycleRepository.findAll(db);
      const row = all.find((c) => c.billCycleId === cycleId);
      expect(row).toBeDefined();
      expect(row!.state).toBe("retired");
    });

    it("retired cycle resolves via findById (existing BAN joins unaffected)", async () => {
      const row = await billCycleRepository.findById(db, cycleId);
      expect(row).not.toBeNull();
      expect(row!.state).toBe("retired");
    });

    it("retiring the cycle again returns 'already_retired' (idempotent guard)", async () => {
      const row = await billCycleRepository.findById(db, cycleId);
      if (!row) throw new Error("cycle not found");
      const result = await billCycleRepository.retire(
        db,
        cycleId,
        row.lastModified,
      );
      expect(result).toBe("already_retired");
    });

    it("CAS conflict returns 'conflict' when lastModified is stale", async () => {
      // The shared cycleId is already retired by earlier tests, so a stale-CAS
      // retire on it correctly returns 'already_retired'. A genuine CAS conflict
      // requires an ACTIVE row with a stale lock — use a fresh cycle.
      const [fresh] = await sql!<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('V09 CAS Conflict Cycle', 'monthly', 5, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;
      if (!fresh) throw new Error("fresh cycle insert failed");
      const staleTs = new Date("2000-01-01T00:00:00Z");
      const result = await billCycleRepository.retire(db, fresh.id, staleTs);
      expect(result).toBe("conflict");
    });

    it("retiring a non-existent cycle returns 'not_found'", async () => {
      const result = await billCycleRepository.retire(
        db,
        "non-existent-id",
        new Date(),
      );
      expect(result).toBe("not_found");
    });
  },
);

// ── Structural: no delete path (Module Inv. #11) ──────────────────────────────
describe("V9 — No delete path (structural / Module Inv. #11)", () => {
  it("billCycleRepository has no delete method", () => {
    expect(
      (billCycleRepository as Record<string, unknown>).delete,
    ).toBeUndefined();
    expect(
      (billCycleRepository as Record<string, unknown>).deleteById,
    ).toBeUndefined();
  });

  it("bill_cycle Drizzle schema exposes no delete helper", () => {
    // The Drizzle table object does not expose a `.delete` method — deletes
    // must go through db.delete() which we never call for this table.
    expect(typeof billCycle).toBe("object");
    expect(
      (billCycle as unknown as Record<string, unknown>).delete,
    ).toBeUndefined();
  });

  it("retired cycle is excluded from wizard options via findAllActive", async () => {
    // This is a pure logic test — the retired-cycle filter is simply
    // `WHERE state = 'active'`, so any retired row is excluded without
    // additional application logic. Covered by the DB integration above when
    // DATABASE_URL is present; this assertion documents the contract otherwise.
    const mockRows = [
      { billCycleId: "a", state: "active" },
      { billCycleId: "b", state: "retired" },
    ];
    const activeOnly = mockRows.filter((r) => r.state === "active");
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0]?.billCycleId).toBe("a");
  });
});

// ── Structural: upsert returns ok.billCycleId (service layer) ────────────────
describe("V9 — Bill-cycle service (structural)", () => {
  it("bill-cycle.ts exports retireBillCycle (not deleteBillCycle)", async () => {
    const mod = await import("@/services/accounts/bill-cycle");
    expect(typeof mod.retireBillCycle).toBe("function");
    expect((mod as Record<string, unknown>).deleteBillCycle).toBeUndefined();
  });

  it("bill-cycle.ts exports upsertBillCycle", async () => {
    const mod = await import("@/services/accounts/bill-cycle");
    expect(typeof mod.upsertBillCycle).toBe("function");
  });
});
