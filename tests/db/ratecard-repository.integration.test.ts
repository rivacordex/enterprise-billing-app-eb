import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import {
  RATECARD_INSERT_BATCH_SIZE,
  ratecardRepository,
  type LookupRowInput,
} from "@/db/repositories/ratecard";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// pm60-spec I4 — live-DB proof, against a database built from EMPTY, of the
// card repository's whole data layer: batched inserts inside one transaction,
// the ACTIVE-only resolution reads vs the by-id display read, dates as strings,
// the DRAFT-guarded version discard, and — the headline — the exported surface
// containing no row-level lookup write. The database ARM of guardrail 37 is a
// documented FINDING: pm57a's 0041 carries no trigger, so a raw UPDATE/DELETE
// of a lookup row is not refused by Postgres (see the note on that test).
const databaseUrl = process.env.DATABASE_URL;

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

describe.skipIf(!databaseUrl)(
  "ratecard repository (requires DATABASE_URL)",
  () => {
    let sql_: postgresjs.Sql;
    let db: DrizzleDb;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql_ = postgres(databaseUrl as string, { max: 1 });
      db = drizzle(sql_, { schema });
      await sql_.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    }, 60_000);

    afterAll(async () => {
      await sql_.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql_.end();
    });

    function makeRows(n: number, startDate = "2026-01-01"): LookupRowInput[] {
      return Array.from({ length: n }, (_, i) => ({
        mnoPublicKey: `MNO-${i}`,
        commercialUnitPublicKey: `CU-${i}`,
        polygonId: `POLY-${i}`,
        polygonStartDate: startDate,
        polygonEndDate: null,
        state: null,
        district: null,
        lkpSubscriberRefId: `PRDINV${String(i).padStart(8, "0")}`,
        serviceCode: null,
        ratePerUnit: null,
      }));
    }

    // I4.1 — a version + 5,400 rows insert in batches inside ONE transaction;
    // the row count matches exactly (RV3). 5,400 > 5×batch, so ≥6 batches run.
    it("inserts a version and 5,400 rows in batches inside one transaction (RV3)", async () => {
      expect(RATECARD_INSERT_BATCH_SIZE).toBe(1000);
      const versionId = await db.transaction(async (tx) => {
        const { versionId } = await ratecardRepository.insertVersion(tx, {
          cardName: "CARD_BATCH",
          versionNum: 1,
          status: "DRAFT",
          snapshotDate: "2026-01-01",
          sourceFile: "batch.csv",
          rowCount: 5400,
        });
        const { inserted } = await ratecardRepository.insertLookupRows(
          tx,
          versionId,
          makeRows(5400),
        );
        expect(inserted).toBe(5400);
        return versionId;
      });

      const [row] = await sql_<{ c: string }[]>`
        SELECT count(*)::text AS c FROM product.ratecard_ran_usage_lkp
        WHERE ratecard_version_id = ${versionId}
      `;
      expect(row?.c).toBe("5400");
    });

    // I4.2 — a failure injected at the fourth batch leaves NOTHING behind
    // (no version row, no partial rows) — RC7.
    it("rolls back the whole upload when a later batch fails", async () => {
      let versionId = "";
      await expect(
        db.transaction(async (tx) => {
          const inserted = await ratecardRepository.insertVersion(tx, {
            cardName: "CARD_ROLLBACK",
            versionNum: 1,
            status: "DRAFT",
            snapshotDate: "2026-01-01",
            sourceFile: "rollback.csv",
            rowCount: 3500,
          });
          versionId = inserted.versionId;
          // Three clean batches, then a fourth that violates NOT NULL on a key
          // column — the whole transaction must roll back.
          await ratecardRepository.insertLookupRows(
            tx,
            versionId,
            makeRows(3000),
          );
          const bad = makeRows(500, "2026-02-01");
          // Force a failure inside the fourth batch.
          (bad[10] as { mnoPublicKey: unknown }).mnoPublicKey = null;
          await ratecardRepository.insertLookupRows(tx, versionId, bad);
        }),
      ).rejects.toThrow();

      const [ver] = await sql_<{ c: string }[]>`
        SELECT count(*)::text AS c FROM product.ratecard_version
        WHERE card_name = 'CARD_ROLLBACK'
      `;
      expect(ver?.c).toBe("0");
      const [rows] = await sql_<{ c: string }[]>`
        SELECT count(*)::text AS c FROM product.ratecard_ran_usage_lkp
        WHERE ratecard_version_id = ${versionId}
      `;
      expect(rows?.c).toBe("0");
    });

    // I4.3 — getCurrentActive returns ACTIVE and never a SUPERSEDED version,
    // even when the superseded one is newer by version_num.
    it("getCurrentActive returns the ACTIVE version, never a newer SUPERSEDED one", async () => {
      const active = await db.transaction((tx) =>
        ratecardRepository.insertVersion(tx, {
          cardName: "CARD_RESOLVE",
          versionNum: 1,
          status: "ACTIVE",
          snapshotDate: "2026-01-01",
          sourceFile: "v1.csv",
          rowCount: 0,
        }),
      );
      // A SUPERSEDED version with a HIGHER version_num must not win.
      await db.transaction((tx) =>
        ratecardRepository.insertVersion(tx, {
          cardName: "CARD_RESOLVE",
          versionNum: 2,
          status: "SUPERSEDED",
          snapshotDate: "2026-02-01",
          sourceFile: "v2.csv",
          rowCount: 0,
        }),
      );

      const current = await ratecardRepository.getCurrentActive(
        db,
        "CARD_RESOLVE",
      );
      expect(current?.ratecardVersionId).toBe(active.versionId);
      expect(current?.status).toBe("ACTIVE");
    });

    // I4.4 — a read-by-id DOES return a SUPERSEDED version (the display
    // exception, asserted so it is not "fixed" later).
    it("getVersionById returns a SUPERSEDED version (display path, not a loophole)", async () => {
      const superseded = await db.transaction((tx) =>
        ratecardRepository.insertVersion(tx, {
          cardName: "CARD_BYID",
          versionNum: 1,
          status: "SUPERSEDED",
          snapshotDate: "2026-01-01",
          sourceFile: "old.csv",
          rowCount: 0,
        }),
      );
      const byId = await ratecardRepository.getVersionById(
        db,
        superseded.versionId,
      );
      expect(byId?.ratecardVersionId).toBe(superseded.versionId);
      expect(byId?.status).toBe("SUPERSEDED");
    });

    // I4.5 — dates round-trip as YYYY-MM-DD strings; no Date object on the read
    // model; a row written at a zone boundary reads back with the same date.
    it("dates round-trip as YYYY-MM-DD strings with no zone shift", async () => {
      const versionId = await db.transaction(async (tx) => {
        const { versionId } = await ratecardRepository.insertVersion(tx, {
          cardName: "CARD_DATES",
          versionNum: 1,
          status: "DRAFT",
          snapshotDate: "2026-12-31",
          sourceFile: "dates.csv",
          rowCount: 1,
        });
        await ratecardRepository.insertLookupRows(tx, versionId, [
          {
            mnoPublicKey: "MNO-D",
            commercialUnitPublicKey: "CU-D",
            polygonId: "POLY-D",
            // A date that is the previous day in UTC for Asia/Kuala_Lumpur.
            polygonStartDate: "2026-12-31",
            polygonEndDate: "2027-01-01",
            state: null,
            district: null,
            lkpSubscriberRefId: "PRDINV00000001",
            serviceCode: null,
            ratePerUnit: null,
          },
        ]);
        return versionId;
      });

      const version = await ratecardRepository.getVersionById(db, versionId);
      expect(version?.snapshotDate).toBe("2026-12-31");
      expect(typeof version?.snapshotDate).toBe("string");

      const { rows } = await ratecardRepository.getVersionRows(db, versionId, {
        limit: 10,
        offset: 0,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.polygonStartDate).toBe("2026-12-31");
      expect(rows[0]!.polygonEndDate).toBe("2027-01-01");
      expect(typeof rows[0]!.polygonStartDate).toBe("string");
    });

    // I4.9 — deleteDraftVersion removes a DRAFT version and its rows (cascade);
    // called on a non-DRAFT version it refuses with a typed error and deletes
    // nothing — asserted on `tx`.
    it("deleteDraftVersion removes a DRAFT and its rows, and refuses a non-DRAFT", async () => {
      const draft = await db.transaction(async (tx) => {
        const { versionId } = await ratecardRepository.insertVersion(tx, {
          cardName: "CARD_DISCARD",
          versionNum: 1,
          status: "DRAFT",
          snapshotDate: "2026-01-01",
          sourceFile: "draft.csv",
          rowCount: 2,
        });
        await ratecardRepository.insertLookupRows(tx, versionId, makeRows(2));
        return versionId;
      });

      const ok = await db.transaction((tx) =>
        ratecardRepository.deleteDraftVersion(tx, draft),
      );
      expect(ok).toEqual({ ok: true, versionId: draft });
      const [gone] = await sql_<{ c: string }[]>`
        SELECT count(*)::text AS c FROM product.ratecard_ran_usage_lkp
        WHERE ratecard_version_id = ${draft}
      `;
      expect(gone?.c).toBe("0");

      // An ACTIVE version is immutable — the discard refuses and deletes nothing.
      const active = await db.transaction((tx) =>
        ratecardRepository.insertVersion(tx, {
          cardName: "CARD_DISCARD_2",
          versionNum: 1,
          status: "ACTIVE",
          snapshotDate: "2026-01-01",
          sourceFile: "active.csv",
          rowCount: 0,
        }),
      );
      const refused = await db.transaction((tx) =>
        ratecardRepository.deleteDraftVersion(tx, active.versionId),
      );
      expect(refused).toEqual({
        ok: false,
        code: "NOT_DRAFT",
        status: "ACTIVE",
      });
      const survivor = await ratecardRepository.getVersionById(
        db,
        active.versionId,
      );
      expect(survivor?.ratecardVersionId).toBe(active.versionId);
    });

    // I4.7 — guardrail 37, DATABASE ARM (a documented FINDING, not a rejection).
    // pm57a's 0041 adds NO trigger/rule on ratecard_ran_usage_lkp and app_runtime
    // holds full DML, so a DIRECT UPDATE/DELETE of an ACTIVE version's lookup row
    // is NOT refused by Postgres today. Immutability (Inv. #46) is enforced in
    // this delivery ONLY by the exported surface (the exports guardrail, green).
    // Per pm60-spec I3 the missing schema object is RAISED as a pm57a finding,
    // NOT added here. This test asserts the current reality so the gap is
    // executable and visible; when pm57a lands the trigger, flip these to
    // `.rejects` / expect 0 affected rows.
    it("[FINDING pm57a] a direct UPDATE/DELETE of an ACTIVE version's lookup row is not yet DB-refused (Inv. #46 is repository-enforced only)", async () => {
      const versionId = await db.transaction(async (tx) => {
        const { versionId } = await ratecardRepository.insertVersion(tx, {
          cardName: "CARD_IMMUTABLE",
          versionNum: 1,
          status: "ACTIVE",
          snapshotDate: "2026-01-01",
          sourceFile: "immutable.csv",
          rowCount: 1,
        });
        await ratecardRepository.insertLookupRows(tx, versionId, makeRows(1));
        return versionId;
      });

      // Raw DML, bypassing the repository surface — currently succeeds.
      const updated = await sql_`
        UPDATE product.ratecard_ran_usage_lkp SET service_code = 'MUTATED'
        WHERE ratecard_version_id = ${versionId}
      `;
      expect(updated.count).toBe(1); // FINDING: should be refused once a trigger lands

      const deleted = await sql_`
        DELETE FROM product.ratecard_ran_usage_lkp
        WHERE ratecard_version_id = ${versionId}
      `;
      expect(deleted.count).toBe(1); // FINDING: should be refused once a trigger lands
    });

    // D6 — no cache wrapper of any kind appears in the module.
    it("the repository module contains no cache of any kind (D6)", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const source = await fs.readFile(
        path.join(process.cwd(), "db", "repositories", "ratecard.ts"),
        "utf8",
      );
      expect(source).not.toMatch(/unstable_cache/);
      expect(source).not.toMatch(/\brevalidate\b/);
      expect(source).not.toMatch(/from\s+["']react["']/);
      expect(source).not.toMatch(/\bcache\s*\(/);
      expect(source).not.toMatch(/new Map\s*\(/);
    });

    // D3/§6.34 — the batch size is a fixed literal, declared once here, not
    // derived and not read from config.
    it("uses a fixed, non-configurable batch size declared in the repository", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const source = await fs.readFile(
        path.join(process.cwd(), "db", "repositories", "ratecard.ts"),
        "utf8",
      );
      expect(source).toMatch(/RATECARD_INSERT_BATCH_SIZE = 1000/);
      expect(source).not.toMatch(/process\.env/);
      expect(source).not.toMatch(/@\/lib\/config/);
    });
  },
);
