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

// pm64-spec I4 — live-DB proof, against a database built from EMPTY, of
// rollback's whole contract: it is a STATUS CHANGE, not an edit. One
// transaction, both versions locked on `tx` immediately before the decision,
// NO lookup-row write of any kind (the headline — a version is exactly its
// file, guardrail 36 / D1), the lineage rule (demoted → target, target's own
// pointer cleared, D3), exactly one audit event carrying the diff counts
// computed IN THE OTHER DIRECTION (D4), and the activate-vs-rollback race
// looped 4× (D5). Same singleton-swap technique as
// tests/db/ratecard-activate-version.integration.test.ts: both services read
// the module singleton `@/db/client` (each opens its own transaction), so it is
// replaced with one built on a real `postgres()` client for this suite.
const databaseUrl = process.env.DATABASE_URL;

const hoisted = vi.hoisted(() => ({
  holder: { db: undefined as unknown },
}));

vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import { rollbackRatecardVersion } from "@/services/product/ratecard/rollback-version";
import { activateRatecardVersion } from "@/services/product/ratecard/activate-version";

describe.skipIf(!databaseUrl)(
  "rollbackRatecardVersion (requires DATABASE_URL)",
  () => {
    let sql_: postgresjs.Sql;
    type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;
    let db: DrizzleDb;
    let actorId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql_ = postgres(databaseUrl as string, {
        // At least 2 physical connections — a concurrent activate/rollback pair
        // against `max: 1` would queue onto one connection and the race this
        // suite exists to exercise (I4.6) would never happen.
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
          userName: "pm64-fixture-operator",
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

    function row(
      polygonId: string,
      ratePerUnit: string | null = null,
    ): LookupRowInput {
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
        ratePerUnit,
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
          sourceFile: "rollback-fixture.csv",
          rowCount: rows.length,
        });
        if (rows.length > 0) {
          await ratecardRepository.insertLookupRows(tx, versionId, rows);
        }
        return versionId;
      });
    }

    async function rowsOf(versionId: string) {
      return db
        .select()
        .from(ratecardRanUsageLkp)
        .where(eq(ratecardRanUsageLkp.ratecardVersionId, versionId))
        .orderBy(asc(ratecardRanUsageLkp.polygonId));
    }

    async function versionOf(versionId: string) {
      const [v] = await db
        .select()
        .from(ratecardVersion)
        .where(eq(ratecardVersion.ratecardVersionId, versionId));
      return v!;
    }

    // I4.1 — rolling back restores the SUPERSEDED version to ACTIVE and demotes
    // the current one, in one transaction, writing provenance columns.
    it("restores a SUPERSEDED version to ACTIVE and demotes the current ACTIVE, in one transaction", async () => {
      const targetId = await makeVersion("CARD_RESTORE", "SUPERSEDED", 1, [
        row("P-1"),
      ]);
      const activeId = await makeVersion("CARD_RESTORE", "ACTIVE", 2, [
        row("P-1"),
        row("P-2"),
      ]);

      const before = Date.now();
      const result = await rollbackRatecardVersion(targetId, actorId);
      expect(result).toMatchObject({ ok: true, versionId: targetId });
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.supersededVersionId).toBe(activeId);

      const target = await versionOf(targetId);
      expect(target.status).toBe("ACTIVE");
      expect(target.activatedBy).toBe(actorId);
      expect(target.activatedAt).toBeInstanceOf(Date);
      expect(target.activatedAt!.getTime()).toBeGreaterThanOrEqual(before);

      const demoted = await versionOf(activeId);
      expect(demoted.status).toBe("SUPERSEDED");
    });

    // I4.2 (the headline) + I4.3 / guardrail 36 — NO lookup row is written:
    // both versions' rows are byte-identical before and after, and neither
    // version's stored row count changes. This is what proves D1.
    it("writes no lookup row — both versions' rows are byte-identical before and after (I4.2/I4.3)", async () => {
      const targetRows = [row("P-1"), row("P-2")];
      const activeRows = [row("P-1"), row("P-3")];
      const targetId = await makeVersion(
        "CARD_NOWRITE",
        "SUPERSEDED",
        1,
        targetRows,
      );
      const activeId = await makeVersion(
        "CARD_NOWRITE",
        "ACTIVE",
        2,
        activeRows,
      );

      const beforeTarget = await rowsOf(targetId);
      const beforeActive = await rowsOf(activeId);

      const result = await rollbackRatecardVersion(targetId, actorId);
      expect(result.ok).toBe(true);

      const afterTarget = await rowsOf(targetId);
      const afterActive = await rowsOf(activeId);

      expect(afterTarget).toEqual(beforeTarget);
      expect(afterActive).toEqual(beforeActive);
      expect(afterTarget.length).toBe(targetRows.length);
      expect(afterActive.length).toBe(activeRows.length);

      expect((await versionOf(targetId)).rowCount).toBe(targetRows.length);
      expect((await versionOf(activeId)).rowCount).toBe(activeRows.length);
    });

    // I4.4 — lineage: the demoted version points at the target; the target's
    // own superseded_by_version_id (which pointed at the version that
    // originally replaced it) is CLEARED (D3).
    it("sets the demoted version's superseded_by_version_id to the target and clears the target's own", async () => {
      const targetId = await makeVersion("CARD_LINEAGE", "SUPERSEDED", 1, [
        row("P-1"),
      ]);
      const activeId = await makeVersion("CARD_LINEAGE", "ACTIVE", 2, [
        row("P-1"),
      ]);
      // Simulate real lineage: the target was originally superseded BY the
      // current ACTIVE, so its pointer is non-null going in.
      await db.transaction((tx) =>
        ratecardRepository.setVersionStatus(tx, targetId, "SUPERSEDED", {
          supersededByVersionId: activeId,
        }),
      );
      expect((await versionOf(targetId)).supersededByVersionId).toBe(activeId);

      await rollbackRatecardVersion(targetId, actorId);

      const target = await versionOf(targetId);
      const demoted = await versionOf(activeId);
      expect(target.status).toBe("ACTIVE");
      expect(target.supersededByVersionId).toBeNull();
      expect(demoted.status).toBe("SUPERSEDED");
      expect(demoted.supersededByVersionId).toBe(targetId);
    });

    // I4.5 — exactly one RATECARD_VERSION_ROLLED_BACK audit event, in the same
    // transaction, carrying the change counts computed IN THE OTHER DIRECTION
    // (target against current ACTIVE, D4).
    it("writes exactly one RATECARD_VERSION_ROLLED_BACK event carrying the demoted id and the other-direction diff counts", async () => {
      // target vs active, in the target-is-new direction:
      //   P-1 payload differs (rate) → changed; P-2, P-4 in target only → added;
      //   P-5 in active only → removed. → {added:2, changed:1, removed:1}
      const targetId = await makeVersion("CARD_AUDIT", "SUPERSEDED", 1, [
        row("P-1", "2.000000"),
        row("P-2"),
        row("P-4"),
      ]);
      const activeId = await makeVersion("CARD_AUDIT", "ACTIVE", 2, [
        row("P-1", "1.000000"),
        row("P-5"),
      ]);

      const result = await rollbackRatecardVersion(targetId, actorId);
      expect(result).toMatchObject({
        ok: true,
        diff: { added: 2, changed: 1, removed: 1 },
      });

      const events = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, targetId));
      expect(events.length).toBe(1);
      const event = events[0]!;
      expect(event.eventType).toBe("RATECARD_VERSION_ROLLED_BACK");
      expect(event.actorUserId).toBe(actorId);
      expect(event.beforeData).toEqual({ supersededVersionId: activeId });
      expect(event.afterData).toMatchObject({
        cardName: "CARD_AUDIT",
        added: 2,
        changed: 1,
        removed: 1,
      });
    });

    // I4.6 / D5 — a concurrent activate/rollback pair, looped 4×, serializes on
    // the current ACTIVE's row lock and NEVER leaves two ACTIVE versions. One
    // user activates the DRAFT, one rolls back to the SUPERSEDED version; both
    // contend on `findActiveForUpdate`'s lock of the card's current ACTIVE.
    // Whoever wins commits; the loser either demotes the by-then-new ACTIVE
    // correctly or is refused by the partial unique index — either way exactly
    // one ACTIVE remains. `allSettled` because the index rejection surfaces as
    // a thrown transaction, which is the backstop working (D5), not a bug.
    it("a concurrent activate/rollback pair serializes and never leaves two ACTIVE versions (looped 4x)", async () => {
      for (let i = 0; i < 4; i++) {
        const cardName = `CARD_RACE_${i}`;
        const supersededId = await makeVersion(cardName, "SUPERSEDED", 1, [
          row("P-1"),
        ]);
        const activeId = await makeVersion(cardName, "ACTIVE", 2, [row("P-2")]);
        const draftId = await makeVersion(cardName, "DRAFT", 3, [row("P-3")]);

        await Promise.allSettled([
          activateRatecardVersion(draftId, actorId),
          rollbackRatecardVersion(supersededId, actorId),
        ]);

        const versions = await db
          .select()
          .from(ratecardVersion)
          .where(eq(ratecardVersion.cardName, cardName));
        const activeCount = versions.filter(
          (v) => v.status === "ACTIVE",
        ).length;
        // The headline invariant of D5: never two ACTIVE, regardless of which
        // racer won or whether the loser was refused by the index.
        expect(activeCount).toBe(1);
        // The old ACTIVE never survives as ACTIVE — it is always demoted by
        // whichever racer committed.
        expect(
          versions.find((v) => v.ratecardVersionId === activeId)?.status,
        ).toBe("SUPERSEDED");
      }
    });

    // I4.7 — a direct attempt to produce a second ACTIVE is refused by the
    // partial unique index; the service refuses it first with a typed code
    // (rolling back an already-ACTIVE version → NOT_SUPERSEDED).
    it("refuses rolling back an ACTIVE version with NOT_SUPERSEDED, and a direct second ACTIVE row is refused by the index", async () => {
      const activeId = await makeVersion("CARD_SECONDACTIVE", "ACTIVE", 1, [
        row("P-1"),
      ]);

      const result = await rollbackRatecardVersion(activeId, actorId);
      expect(result).toEqual({
        ok: false,
        code: "NOT_SUPERSEDED",
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

    // I4.8 — rolling back to a version that is not SUPERSEDED (a DRAFT, or the
    // current ACTIVE) is refused with a typed code and NO write.
    it("refuses rolling back a DRAFT or the current ACTIVE with a typed code and no write", async () => {
      const draftId = await makeVersion("CARD_NOTSUP", "DRAFT", 1, [
        row("P-1"),
      ]);
      const activeId = await makeVersion("CARD_NOTSUP", "ACTIVE", 2, [
        row("P-1"),
      ]);

      const draftResult = await rollbackRatecardVersion(draftId, actorId);
      expect(draftResult).toEqual({
        ok: false,
        code: "NOT_SUPERSEDED",
        status: "DRAFT",
      });

      const activeResult = await rollbackRatecardVersion(activeId, actorId);
      expect(activeResult).toEqual({
        ok: false,
        code: "NOT_SUPERSEDED",
        status: "ACTIVE",
      });

      // No write: statuses unchanged, no audit event for either.
      expect((await versionOf(draftId)).status).toBe("DRAFT");
      expect((await versionOf(activeId)).status).toBe("ACTIVE");
      const events = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, draftId));
      expect(events.length).toBe(0);
    });

    // I4.9 — rolling back when there is no current ACTIVE succeeds: the target
    // simply becomes ACTIVE, with no null-pointer path. The diff computes every
    // key as "added" (getCurrentActiveRows returns none).
    it("succeeds with no current ACTIVE — the target becomes ACTIVE and nothing is demoted", async () => {
      const targetId = await makeVersion("CARD_NOACTIVE", "SUPERSEDED", 1, [
        row("P-1"),
        row("P-2"),
      ]);

      const result = await rollbackRatecardVersion(targetId, actorId);
      expect(result).toMatchObject({
        ok: true,
        versionId: targetId,
        supersededVersionId: null,
        diff: { added: 2, changed: 0, removed: 0 },
      });
      expect((await versionOf(targetId)).status).toBe("ACTIVE");
    });

    // I4.10 — undo-the-undo: a rollback followed by re-activating the newer
    // version (itself now SUPERSEDED) restores it exactly, both directions
    // byte-clean. No row of either version is ever touched.
    it("undo-the-undo restores exactly, both directions byte-clean", async () => {
      const v1 = await makeVersion("CARD_UNDO", "SUPERSEDED", 1, [
        row("P-1"),
        row("P-2"),
      ]);
      const v2 = await makeVersion("CARD_UNDO", "ACTIVE", 2, [
        row("P-1"),
        row("P-3"),
      ]);
      const v1RowsInitial = await rowsOf(v1);
      const v2RowsInitial = await rowsOf(v2);

      // Undo: roll back to v1 → v1 ACTIVE, v2 SUPERSEDED.
      await rollbackRatecardVersion(v1, actorId);
      expect((await versionOf(v1)).status).toBe("ACTIVE");
      expect((await versionOf(v2)).status).toBe("SUPERSEDED");

      // Undo the undo: roll back to v2 (now SUPERSEDED) → v2 ACTIVE, v1 SUPERSEDED.
      await rollbackRatecardVersion(v2, actorId);
      expect((await versionOf(v2)).status).toBe("ACTIVE");
      expect((await versionOf(v1)).status).toBe("SUPERSEDED");

      // Both versions' rows are unchanged throughout — nothing was ever edited.
      expect(await rowsOf(v1)).toEqual(v1RowsInitial);
      expect(await rowsOf(v2)).toEqual(v2RowsInitial);
    });
  },
);
