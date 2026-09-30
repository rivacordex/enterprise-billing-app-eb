import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { asc, eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { ratecardRanUsageLkp, ratecardVersion } from "@/db/schema/product";
import {
  ratecardRepository,
  type LookupRowInput,
} from "@/db/repositories/ratecard";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// pm63-spec I4 — live-DB proof, against a database built from EMPTY, of
// activation's whole contract: one transaction, one lock read on `tx`
// immediately before the decision, no lookup-row write of any kind (guardrail
// 36 — a version is exactly its file), the service arm of guardrail 39 (the
// index arm landed at pm57a — tests/db/product-ratecard-schema.integration.test.ts),
// the two-concurrent-activations race looped 4×, and exactly one audit event
// carrying the superseded id and the diff counts computed inside the
// transaction. `activateRatecardVersion` reads the module singleton
// `@/db/client` (it opens its own transaction, D1) rather than taking `db` as
// an argument, so — matching
// tests/db/ratecard-upload-version.integration.test.ts's precedent — that
// singleton is replaced with one built on a real `postgres()` client for this
// suite.
const databaseUrl = process.env.DATABASE_URL;

const hoisted = vi.hoisted(() => ({
  holder: { db: undefined as unknown },
}));

vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import { activateRatecardVersion } from "@/services/product/ratecard/activate-version";

describe.skipIf(!databaseUrl)(
  "activateRatecardVersion (requires DATABASE_URL)",
  () => {
    let sql_: postgresjs.Sql;
    type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;
    let db: DrizzleDb;
    let actorId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql_ = postgres(databaseUrl as string, {
        // At least 2 physical connections — two "concurrent" activations
        // against `max: 1` would just queue onto one connection and the race
        // this suite exists to exercise would never happen (I4.4).
        max: 5,
        onnotice: () => {},
      });
      await sql_.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql_.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql_, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      hoisted.holder.db = db;

      const [actor] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "pm63-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
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

    function row(polygonId: string): LookupRowInput {
      return {
        mnoPublicKey: "MNO-1",
        commercialUnitPublicKey: "CU-1",
        polygonId,
        polygonStartDate: "2026-01-01",
        polygonEndDate: null,
        state: null,
        district: null,
        lkpSubscriberRefId: "PRDINV00000001",
        serviceCode: null,
        ratePerUnit: null,
      };
    }

    async function makeVersion(
      cardName: string,
      status: "DRAFT" | "ACTIVE" | "SUPERSEDED",
      versionNum: number,
      rows: LookupRowInput[],
    ): Promise<string> {
      return db.transaction(async (tx) => {
        const { versionId } = await ratecardRepository.insertVersion(tx, {
          cardName,
          versionNum,
          status,
          snapshotDate: "2026-01-01",
          sourceFile: "activate-fixture.csv",
          rowCount: rows.length,
        });
        if (rows.length > 0) {
          await ratecardRepository.insertLookupRows(tx, versionId, rows);
        }
        return versionId;
      });
    }

    // I4.1 — promotes the DRAFT, demotes the prior ACTIVE, writes
    // superseded_by_version_id / activated_by / activated_at, in one
    // transaction.
    it("promotes the DRAFT and demotes the prior ACTIVE, writing provenance columns, in one transaction", async () => {
      const activeId = await makeVersion("CARD_PROMOTE", "ACTIVE", 1, [
        row("P-1"),
      ]);
      const draftId = await makeVersion("CARD_PROMOTE", "DRAFT", 2, [
        row("P-1"),
        row("P-2"),
      ]);

      const before = Date.now();
      const result = await activateRatecardVersion(draftId, actorId);
      expect(result).toMatchObject({ ok: true, versionId: draftId });
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.supersededVersionId).toBe(activeId);
      expect(result.diff).toEqual({ added: 1, changed: 0, removed: 0 });

      const [promoted] = await db
        .select()
        .from(ratecardVersion)
        .where(eq(ratecardVersion.ratecardVersionId, draftId));
      expect(promoted?.status).toBe("ACTIVE");
      expect(promoted?.activatedBy).toBe(actorId);
      expect(promoted?.activatedAt).toBeInstanceOf(Date);
      expect(promoted!.activatedAt!.getTime()).toBeGreaterThanOrEqual(before);

      const [superseded] = await db
        .select()
        .from(ratecardVersion)
        .where(eq(ratecardVersion.ratecardVersionId, activeId));
      expect(superseded?.status).toBe("SUPERSEDED");
      expect(superseded?.supersededByVersionId).toBe(draftId);
    });

    // I4.2 / guardrail 36 — NO lookup row is written: both versions' rows are
    // byte-identical before and after, and the incoming version's stored rows
    // equal its row_count (D6).
    it("writes no lookup row — both versions' rows are byte-identical before and after activation (guardrail 36)", async () => {
      const activeRows = [row("P-1"), row("P-2")];
      const draftRows = [row("P-1"), row("P-3")];
      const activeId = await makeVersion(
        "CARD_NOROWWRITE",
        "ACTIVE",
        1,
        activeRows,
      );
      const draftId = await makeVersion(
        "CARD_NOROWWRITE",
        "DRAFT",
        2,
        draftRows,
      );

      const beforeActive = await db
        .select()
        .from(ratecardRanUsageLkp)
        .where(eq(ratecardRanUsageLkp.ratecardVersionId, activeId))
        .orderBy(asc(ratecardRanUsageLkp.polygonId));
      const beforeDraft = await db
        .select()
        .from(ratecardRanUsageLkp)
        .where(eq(ratecardRanUsageLkp.ratecardVersionId, draftId))
        .orderBy(asc(ratecardRanUsageLkp.polygonId));

      const result = await activateRatecardVersion(draftId, actorId);
      expect(result.ok).toBe(true);

      const afterActive = await db
        .select()
        .from(ratecardRanUsageLkp)
        .where(eq(ratecardRanUsageLkp.ratecardVersionId, activeId))
        .orderBy(asc(ratecardRanUsageLkp.polygonId));
      const afterDraft = await db
        .select()
        .from(ratecardRanUsageLkp)
        .where(eq(ratecardRanUsageLkp.ratecardVersionId, draftId))
        .orderBy(asc(ratecardRanUsageLkp.polygonId));

      expect(afterActive).toEqual(beforeActive);
      expect(afterDraft).toEqual(beforeDraft);
      expect(afterDraft.length).toBe(draftRows.length);

      const [promoted] = await db
        .select()
        .from(ratecardVersion)
        .where(eq(ratecardVersion.ratecardVersionId, draftId));
      expect(promoted?.rowCount).toBe(draftRows.length);
    });

    // I4.3 — a second ACTIVE for one card_name is refused by the partial
    // unique index; the service refuses first with a typed code
    // (guardrail 39, service arm — the index arm landed at pm57a).
    it("refuses re-activating an already-ACTIVE version with a typed NOT_DRAFT code, and a direct second ACTIVE row is refused by the index", async () => {
      const activeId = await makeVersion("CARD_SECONDACTIVE", "ACTIVE", 1, [
        row("P-1"),
      ]);

      const result = await activateRatecardVersion(activeId, actorId);
      expect(result).toEqual({
        ok: false,
        code: "NOT_DRAFT",
        status: "ACTIVE",
      });

      await expect(
        db.transaction(async (tx) => {
          await ratecardRepository.insertVersion(tx, {
            cardName: "CARD_SECONDACTIVE",
            versionNum: 2,
            status: "ACTIVE",
            snapshotDate: "2026-01-01",
            sourceFile: "direct-sql.csv",
            rowCount: 0,
          });
        }),
      ).rejects.toThrow(/ratecard_version_one_active_per_card/);
    });

    // I4.4 / guardrail 39 race — two concurrent activations for one card,
    // looped 4×, serialize on the lock and leave exactly one ACTIVE: the
    // second racer's lock wait re-reads the (by-then-ACTIVE) draft's status
    // and is refused NOT_DRAFT rather than double-activating.
    it("two concurrent activations for one card serialize on the lock and leave exactly one ACTIVE (looped 4x)", async () => {
      for (let i = 0; i < 4; i++) {
        const cardName = `CARD_RACE_${i}`;
        const activeId = await makeVersion(cardName, "ACTIVE", 1, [row("P-1")]);
        const draftId = await makeVersion(cardName, "DRAFT", 2, [row("P-1")]);

        const [r1, r2] = await Promise.all([
          activateRatecardVersion(draftId, actorId),
          activateRatecardVersion(draftId, actorId),
        ]);

        const outcomes = [r1, r2];
        const succeeded = outcomes.filter((r) => r.ok);
        const refused = outcomes.filter((r) => !r.ok && r.code === "NOT_DRAFT");
        expect(succeeded.length).toBe(1);
        expect(refused.length).toBe(1);

        const activeRows = await db
          .select()
          .from(ratecardVersion)
          .where(eq(ratecardVersion.cardName, cardName));
        const activeCount = activeRows.filter(
          (v) => v.status === "ACTIVE",
        ).length;
        expect(activeCount).toBe(1);
        expect(
          activeRows.find((v) => v.ratecardVersionId === draftId)?.status,
        ).toBe("ACTIVE");
        expect(
          activeRows.find((v) => v.ratecardVersionId === activeId)?.status,
        ).toBe("SUPERSEDED");
      }
    });

    // I4.5 — exactly one audit event, in the same transaction, carrying the
    // superseded id and the change counts computed INSIDE the transaction.
    it("writes exactly one RATECARD_VERSION_ACTIVATED audit event carrying the superseded id and the diff counts", async () => {
      const activeId = await makeVersion("CARD_AUDIT", "ACTIVE", 1, [
        row("P-1"),
        row("P-2"),
      ]);
      const draftId = await makeVersion("CARD_AUDIT", "DRAFT", 2, [
        row("P-1"),
        row("P-3"),
      ]);

      await activateRatecardVersion(draftId, actorId);

      const events = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, draftId));
      expect(events.length).toBe(1);
      const event = events[0]!;
      expect(event.eventType).toBe("RATECARD_VERSION_ACTIVATED");
      expect(event.actorUserId).toBe(actorId);
      expect(event.beforeData).toEqual({ supersededVersionId: activeId });
      expect(event.afterData).toMatchObject({
        cardName: "CARD_AUDIT",
        added: 1,
        changed: 0,
        removed: 1,
      });
    });
  },
);
