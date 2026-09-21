import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import {
  productOffering,
  productOfferingPrice,
  productSpecifications,
} from "@/db/schema/product";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { LifecycleStatus } from "@/types/product";
import type { submitForTesting as SubmitForTesting } from "@/services/product/submit-for-testing";
import type { returnToDraft as ReturnToDraft } from "@/services/product/return-to-draft";
import type { activateOffering as ActivateOffering } from "@/services/product/activate-offering";
import type { updateOffering as UpdateOffering } from "@/services/product/update-offering";

// pm42-spec I7. Live-DB proof of the release path DRAFT → TESTING → ACTIVE plus
// TESTING → DRAFT: each transition succeeds from its legal predecessor and every
// other ordered pair returns its typed code; submit enforces the relocated
// preconditions; activation supersedes the family's previous ACTIVE version to
// OBSOLETE (not RETIRED) in one transaction with exactly one ACTIVE surviving;
// each transition writes exactly one audit row. The services use their own
// `@/db/client` pool; the local `db`/`sql` handles drive setup and assertions.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "product release path (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let submitForTesting: typeof SubmitForTesting;
    let returnToDraft: typeof ReturnToDraft;
    let activateOffering: typeof ActivateOffering;
    let updateOffering: typeof UpdateOffering;
    let actorId: string;
    let uniqueCounter = 0;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 4 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      const [submitMod, returnMod, activateMod, updateMod] = await Promise.all([
        import("@/services/product/submit-for-testing"),
        import("@/services/product/return-to-draft"),
        import("@/services/product/activate-offering"),
        import("@/services/product/update-offering"),
      ]);
      submitForTesting = submitMod.submitForTesting;
      returnToDraft = returnMod.returnToDraft;
      activateOffering = activateMod.activateOffering;
      updateOffering = updateMod.updateOffering;

      const [user] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "Release Manager",
          userEmail: `${crypto.randomUUID()}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = user!.id;
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    // A DRAFT root offering in its own family, optionally seeded so submit's
    // preconditions pass: a complete recurring price and a resolved mandatory
    // specification. Children are inserted while DRAFT (§3.5 trigger).
    async function createDraft(opts?: {
      price?: boolean;
      spec?: "resolved" | "unresolved" | "empty" | "none";
    }): Promise<string> {
      uniqueCounter += 1;
      const [row] = await db
        .insert(productOffering)
        .values({
          name: `PMRP-Offering-${uniqueCounter}`,
          isBundle: false,
          isSellable: true,
          billingOnly: false,
          lifecycleStatus: "DRAFT",
          version: 1,
          familyOfferingId: null,
        })
        .returning({ id: productOffering.productOfferingId });
      const offeringId = row!.id;

      if (opts?.price !== false) {
        await db.insert(productOfferingPrice).values({
          productOfferingId: offeringId,
          name: "Monthly",
          priceType: "recurring",
          recurringChargePeriodLength: 1,
          recurringChargePeriodType: "months",
          amount: "10.00",
          currency: "USD",
          pricingModel: "flat",
          startDateTime: new Date("2026-01-01T00:00:00Z"),
        });
      }

      const specMode = opts?.spec ?? "resolved";
      if (specMode !== "none") {
        const defaultValue =
          specMode === "resolved"
            ? "01"
            : specMode === "empty"
              ? "   " // whitespace-only — must count as unresolved (pm44 review)
              : null;
        await db.insert(productSpecifications).values({
          refProductOfferingId: offeringId,
          name: "SST identifier",
          isMandatory: true,
          isDefault: true,
          defaultValue,
          productSpecCharacteristics: {},
        });
      }

      return offeringId;
    }

    // Fixture shortcut: flip an offering's status directly (not the code path
    // under test) so a transition's guard can be exercised from a given state.
    async function forceStatus(
      offeringId: string,
      status: LifecycleStatus,
    ): Promise<void> {
      await db
        .update(productOffering)
        .set({ lifecycleStatus: status })
        .where(eq(productOffering.productOfferingId, offeringId));
    }

    async function statusOf(offeringId: string): Promise<LifecycleStatus> {
      const [row] = await db
        .select({ status: productOffering.lifecycleStatus })
        .from(productOffering)
        .where(eq(productOffering.productOfferingId, offeringId));
      return row!.status as LifecycleStatus;
    }

    async function auditCount(
      targetId: string,
      eventType: string,
    ): Promise<number> {
      const [row] = await db
        .select({ c: count() })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetId, targetId),
            eq(auditLog.eventType, eventType),
          ),
        );
      return row?.c ?? 0;
    }

    const MISSING_ID = "PRDOFR99999999";

    // --- Legal transitions ------------------------------------------------

    it("DRAFT → TESTING succeeds, writes one SUBMITTED_FOR_TESTING audit row", async () => {
      const id = await createDraft();
      const result = await submitForTesting(id, { reason: "ready" }, actorId);

      expect(result).toEqual({ ok: true, offeringId: id });
      expect(await statusOf(id)).toBe("TESTING");
      expect(
        await auditCount(id, "PRODUCT_OFFERING_SUBMITTED_FOR_TESTING"),
      ).toBe(1);
    });

    it("TESTING → DRAFT succeeds, restores editability, writes one RETURNED_TO_DRAFT audit row", async () => {
      const id = await createDraft();
      await submitForTesting(id, {}, actorId);

      const result = await returnToDraft(id, { reason: "one fix" }, actorId);

      expect(result).toEqual({ ok: true, offeringId: id });
      expect(await statusOf(id)).toBe("DRAFT");
      expect(await auditCount(id, "PRODUCT_OFFERING_RETURNED_TO_DRAFT")).toBe(
        1,
      );

      // Editable again: a child write against the now-DRAFT parent succeeds
      // (the §3.5 trigger's DRAFT condition is satisfied again).
      await expect(
        db.insert(productSpecifications).values({
          refProductOfferingId: id,
          name: "Extra spec",
          isMandatory: false,
          isDefault: false,
          defaultValue: null,
          productSpecCharacteristics: {},
        }),
      ).resolves.toBeDefined();
    });

    it("TESTING → ACTIVE succeeds with no sibling, leaves the family with exactly one ACTIVE", async () => {
      const id = await createDraft();
      await submitForTesting(id, {}, actorId);

      const result = await activateOffering(id, {}, actorId);

      expect(result).toEqual({
        ok: true,
        offeringId: id,
        supersededOfferingId: null,
      });
      expect(await statusOf(id)).toBe("ACTIVE");
      expect(await auditCount(id, "PRODUCT_OFFERING_ACTIVATED")).toBe(1);
    });

    // --- Illegal ordered pairs -------------------------------------------

    it("submitForTesting refuses every non-DRAFT predecessor with OFFERING_NOT_DRAFT", async () => {
      for (const status of [
        "TESTING",
        "ACTIVE",
        "OBSOLETE",
        "RETIRED",
      ] as const) {
        const id = await createDraft();
        await forceStatus(id, status);
        const result = await submitForTesting(id, {}, actorId);
        expect(result).toEqual({ ok: false, code: "OFFERING_NOT_DRAFT" });
      }
    });

    it("returnToDraft refuses every non-TESTING predecessor with OFFERING_NOT_TESTING", async () => {
      for (const status of [
        "DRAFT",
        "ACTIVE",
        "OBSOLETE",
        "RETIRED",
      ] as const) {
        const id = await createDraft();
        await forceStatus(id, status);
        const result = await returnToDraft(id, {}, actorId);
        expect(result).toEqual({ ok: false, code: "OFFERING_NOT_TESTING" });
      }
    });

    it("activateOffering refuses every non-TESTING predecessor with OFFERING_NOT_TESTING", async () => {
      for (const status of [
        "DRAFT",
        "ACTIVE",
        "OBSOLETE",
        "RETIRED",
      ] as const) {
        const id = await createDraft();
        await forceStatus(id, status);
        const result = await activateOffering(id, {}, actorId);
        expect(result).toEqual({ ok: false, code: "OFFERING_NOT_TESTING" });
      }
    });

    it("every transition returns OFFERING_NOT_FOUND for an unknown offering", async () => {
      expect(await submitForTesting(MISSING_ID, {}, actorId)).toEqual({
        ok: false,
        code: "OFFERING_NOT_FOUND",
      });
      expect(await returnToDraft(MISSING_ID, {}, actorId)).toEqual({
        ok: false,
        code: "OFFERING_NOT_FOUND",
      });
      expect(await activateOffering(MISSING_ID, {}, actorId)).toEqual({
        ok: false,
        code: "OFFERING_NOT_FOUND",
      });
    });

    // --- Submit preconditions --------------------------------------------

    it("submit refuses a DRAFT with no price rows (NO_PRICE_ROWS)", async () => {
      const id = await createDraft({ price: false });
      const result = await submitForTesting(id, {}, actorId);
      expect(result).toEqual({ ok: false, code: "NO_PRICE_ROWS" });
      expect(await statusOf(id)).toBe("DRAFT");
    });

    it("submit refuses a DRAFT whose mandatory specification is unresolved (SPECIFICATIONS_NOT_RESOLVED)", async () => {
      const id = await createDraft({ spec: "unresolved" });
      const result = await submitForTesting(id, {}, actorId);
      expect(result).toEqual({
        ok: false,
        code: "SPECIFICATIONS_NOT_RESOLVED",
      });
      expect(await statusOf(id)).toBe("DRAFT");
    });

    it("submit refuses a DRAFT with no specifications at all (SPECIFICATIONS_NOT_RESOLVED)", async () => {
      const id = await createDraft({ spec: "none" });
      const result = await submitForTesting(id, {}, actorId);
      expect(result).toEqual({
        ok: false,
        code: "SPECIFICATIONS_NOT_RESOLVED",
      });
    });

    it("submit refuses a DRAFT whose mandatory spec default is blank/whitespace (pm44 review — 'resolved' means non-empty)", async () => {
      const id = await createDraft({ spec: "empty" });
      const result = await submitForTesting(id, {}, actorId);
      expect(result).toEqual({
        ok: false,
        code: "SPECIFICATIONS_NOT_RESOLVED",
      });
      expect(await statusOf(id)).toBe("DRAFT");
    });

    // --- Supersession ----------------------------------------------------

    it("activation with a sibling supersedes it to OBSOLETE: one ACTIVE, one OBSOLETE, two audit rows", async () => {
      // Family root A: DRAFT → submit → activate (now ACTIVE).
      const rootId = await createDraft();
      await submitForTesting(rootId, {}, actorId);
      await activateOffering(rootId, {}, actorId);

      // Branch a new DRAFT B off A (clones the spec + price), then submit +
      // activate B — it must supersede A.
      const { offeringId: branchId } = await db.transaction((tx) =>
        productOfferingRepository.branchOfferingAsDraft(tx, rootId),
      );
      await submitForTesting(branchId, {}, actorId);
      const result = await activateOffering(branchId, {}, actorId);

      expect(result).toEqual({
        ok: true,
        offeringId: branchId,
        supersededOfferingId: rootId,
      });
      expect(await statusOf(branchId)).toBe("ACTIVE");
      expect(await statusOf(rootId)).toBe("OBSOLETE");

      // Exactly one ACTIVE remains across the whole family.
      const activeRows = await db
        .select({ id: productOffering.productOfferingId })
        .from(productOffering)
        .where(eq(productOffering.lifecycleStatus, "ACTIVE"));
      const familyActive = activeRows.filter(
        (r) => r.id === rootId || r.id === branchId,
      );
      expect(familyActive).toHaveLength(1);

      // Two audit rows: the activation of B and the supersession of A.
      expect(await auditCount(branchId, "PRODUCT_OFFERING_ACTIVATED")).toBe(1);
      expect(await auditCount(rootId, "PRODUCT_OFFERING_SUPERSEDED")).toBe(1);

      // The supersession's afterData records the OBSOLETE status (D5).
      const [supersededEvent] = await db
        .select({ afterData: auditLog.afterData })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetId, rootId),
            eq(auditLog.eventType, "PRODUCT_OFFERING_SUPERSEDED"),
          ),
        );
      expect(
        (supersededEvent?.afterData as { lifecycleStatus?: string })
          .lifecycleStatus,
      ).toBe("OBSOLETE");
    });

    // --- Not-editable branch guard (Inv. #14) ----------------------------

    it("branchOfferingAsDraft refuses a non-editable source (TESTING/OBSOLETE/RETIRED); ACTIVE still branches", async () => {
      for (const status of ["TESTING", "OBSOLETE", "RETIRED"] as const) {
        const id = await createDraft();
        await forceStatus(id, status);
        await expect(
          db.transaction((tx) =>
            productOfferingRepository.branchOfferingAsDraft(tx, id),
          ),
        ).rejects.toThrow(/not branchable/);
      }

      // The legitimate branch-on-edit source (ACTIVE) still clones fine.
      const activeId = await createDraft();
      await forceStatus(activeId, "ACTIVE");
      const { offeringId } = await db.transaction((tx) =>
        productOfferingRepository.branchOfferingAsDraft(tx, activeId),
      );
      expect(offeringId).toBeTruthy();
    });

    it("editing an ACTIVE version whose family already has an open version returns OFFERING_HAS_OPEN_VERSION (pm44 review)", async () => {
      // root ACTIVE + a branched TESTING version occupy the family's one active
      // and one open slot.
      const rootId = await createDraft();
      await submitForTesting(rootId, {}, actorId);
      await activateOffering(rootId, {}, actorId);
      const { offeringId: branchId } = await db.transaction((tx) =>
        productOfferingRepository.branchOfferingAsDraft(tx, rootId),
      );
      await submitForTesting(branchId, {}, actorId);

      // Editing the ACTIVE root would branch a second open version — the
      // one-open index rejects it, surfaced as a typed code, not SERVER_ERROR.
      const result = await updateOffering(
        rootId,
        {
          name: "Renamed",
          isSellable: true,
          billingOnly: false,
          saveAsNew: false,
        },
        actorId,
      );
      expect(result).toEqual({ ok: false, code: "OFFERING_HAS_OPEN_VERSION" });
    });

    it("updateOffering refuses a TESTING or OBSOLETE version with OFFERING_NOT_EDITABLE (Inv. #14)", async () => {
      for (const status of ["TESTING", "OBSOLETE"] as const) {
        const id = await createDraft();
        await forceStatus(id, status);
        const result = await updateOffering(
          id,
          {
            name: "Renamed",
            isSellable: true,
            billingOnly: false,
            saveAsNew: false,
          },
          actorId,
        );
        expect(result).toEqual({ ok: false, code: "OFFERING_NOT_EDITABLE" });
        // Untouched: still its forced status, name unchanged.
        expect(await statusOf(id)).toBe(status);
      }
    });

    // --- Concurrency -----------------------------------------------------

    // pm42 I7 asks for "two near-simultaneous activations of sibling TESTING
    // versions". Under pm36's `product_offering_one_open_per_family` index a
    // family can hold at most ONE open (DRAFT or TESTING) version, so two TESTING
    // siblings cannot coexist — that scenario is structurally impossible. The
    // real race is the same TESTING version activated twice (a double submit):
    // `findActiveInFamily`'s family-wide FOR UPDATE serializes them, so exactly
    // one wins and the family never holds two ACTIVE rows.
    it("two concurrent activations of one TESTING version: exactly one wins, one ACTIVE survives", async () => {
      // A single TESTING version in its own family (the family already holds its
      // one permitted open version, so there is no sibling to branch — that is
      // exactly why two TESTING siblings cannot exist). Fire its activation
      // twice concurrently.
      const id = await createDraft();
      await submitForTesting(id, {}, actorId);

      const [r1, r2] = await Promise.all([
        activateOffering(id, {}, actorId),
        activateOffering(id, {}, actorId),
      ]);

      const wins = [r1, r2].filter((r) => r.ok);
      expect(wins).toHaveLength(1);
      const losers = [r1, r2].filter((r) => !r.ok);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toEqual({ ok: false, code: "OFFERING_NOT_TESTING" });

      expect(await statusOf(id)).toBe("ACTIVE");
      // Exactly one activation was recorded — the loser wrote no audit row.
      expect(await auditCount(id, "PRODUCT_OFFERING_ACTIVATED")).toBe(1);
    });
  },
);
