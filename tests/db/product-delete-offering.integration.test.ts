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
import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { LifecycleStatus } from "@/types/product";
import type { deleteOffering as DeleteOffering } from "@/services/product/delete-offering";

// pm44-spec I6. Live-DB proof of discard: a DRAFT/TESTING version and its
// specs/prices are hard-deleted in one transaction (parent-first cascade — the
// only path pm36's trigger permits for a TESTING parent); ACTIVE/OBSOLETE/RETIRED
// are refused with the observed status; the PRODUCT_OFFERING_DELETED audit row
// carries the exact removed counts; siblings and the family graph survive; the
// open-version index frees up; the trigger still refuses a direct child delete on
// a released version; and a pre-existing PRODUCT_OFFERING_DISCARDED row still
// renders (D5).
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "product discard / hard delete (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let deleteOffering: typeof DeleteOffering;
    let actorId: string;
    let uniqueCounter = 0;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 4 });
      for (const s of [
        "billing",
        "customer",
        "product",
        "inventory",
        "ordering",
        "rating",
        "core",
        "drizzle",
      ]) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      ({ deleteOffering } = await import("@/services/product/delete-offering"));

      const [user] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "Discard Manager",
          userEmail: `${crypto.randomUUID()}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = user!.id;
    }, 30_000);

    afterAll(async () => {
      if (!sql) return;
      for (const s of [
        "billing",
        "customer",
        "product",
        "inventory",
        "ordering",
        "rating",
        "core",
        "drizzle",
      ]) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
      await sql.end();
    });

    // A DRAFT offering with `specs` specifications and `prices` recurring price
    // rows (distinct start dates for the unique (offering, type, start) index),
    // all inserted while DRAFT so pm36's trigger permits them.
    async function createDraft(opts?: {
      specs?: number;
      prices?: number;
    }): Promise<string> {
      uniqueCounter += 1;
      const [offering] = await db
        .insert(productOffering)
        .values({
          name: `PMDEL-Offering-${uniqueCounter}`,
          isBundle: false,
          isSellable: true,
          billingOnly: false,
          lifecycleStatus: "DRAFT",
          version: 1,
          familyOfferingId: null,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      const offeringId = offering!.productOfferingId;

      const specCount = opts?.specs ?? 0;
      for (let i = 0; i < specCount; i += 1) {
        await db.insert(productSpecifications).values({
          refProductOfferingId: offeringId,
          name: `Spec ${i}`,
          isMandatory: false,
          isDefault: false,
          defaultValue: null,
          productSpecCharacteristics: {},
        });
      }
      const priceCount = opts?.prices ?? 0;
      for (let i = 0; i < priceCount; i += 1) {
        await db.insert(productOfferingPrice).values({
          productOfferingId: offeringId,
          name: `Price ${i}`,
          componentType: "flat_fee",
          priceComponent: {
            "@type": "flat_fee",
            specVersion: 1,
            plaSpecId: null,
            priceType: "recurring",
            appliesAt: "billing",
            basis: "flat",
            boundTo: null,
            params: { amount: "10.00" },
          },
          recurringChargePeriodLength: 1,
          recurringChargePeriodType: "months",
          currency: "USD",
          startDateTime: new Date(`2026-0${i + 1}-01T00:00:00Z`),
        });
      }
      return offeringId;
    }

    async function forceStatus(
      offeringId: string,
      status: LifecycleStatus,
    ): Promise<void> {
      await db
        .update(productOffering)
        .set({ lifecycleStatus: status })
        .where(eq(productOffering.productOfferingId, offeringId));
    }

    async function offeringExists(offeringId: string): Promise<boolean> {
      const [row] = await db
        .select({ c: count() })
        .from(productOffering)
        .where(eq(productOffering.productOfferingId, offeringId));
      return (row?.c ?? 0) > 0;
    }

    async function specCountOf(offeringId: string): Promise<number> {
      const [row] = await db
        .select({ c: count() })
        .from(productSpecifications)
        .where(eq(productSpecifications.refProductOfferingId, offeringId));
      return row?.c ?? 0;
    }

    async function priceCountOf(offeringId: string): Promise<number> {
      const [row] = await db
        .select({ c: count() })
        .from(productOfferingPrice)
        .where(eq(productOfferingPrice.productOfferingId, offeringId));
      return row?.c ?? 0;
    }

    async function deletedAuditBefore(
      offeringId: string,
    ): Promise<Record<string, unknown> | null> {
      const [row] = await db
        .select({ beforeData: auditLog.beforeData })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetId, offeringId),
            eq(auditLog.eventType, "PRODUCT_OFFERING_DELETED"),
          ),
        );
      return (row?.beforeData as Record<string, unknown> | undefined) ?? null;
    }

    const MISSING_ID = "PRDOFR99999999";

    it("deletes a DRAFT with 2 specs and 2 prices — exactly those five rows, audit carries the counts", async () => {
      const offeringId = await createDraft({ specs: 2, prices: 2 });

      const result = await deleteOffering(
        offeringId,
        { reason: "oops" },
        actorId,
      );

      expect(result).toEqual({
        ok: true,
        offeringId,
        familyId: offeringId,
        familyRemains: false,
        specificationsRemoved: 2,
        pricesRemoved: 2,
      });
      // The offering and both child rows are gone (parent-first cascade).
      expect(await offeringExists(offeringId)).toBe(false);
      expect(await specCountOf(offeringId)).toBe(0);
      expect(await priceCountOf(offeringId)).toBe(0);

      // The audit payload is the only survivor (D4): id, name, version, status,
      // family, and the exact removed counts.
      const before = await deletedAuditBefore(offeringId);
      expect(before).toMatchObject({
        offeringId,
        version: 1,
        lifecycleStatus: "DRAFT",
        familyOfferingId: null,
        specificationsRemoved: 2,
        pricesRemoved: 2,
      });
    });

    it("deletes a TESTING version identically (parent-first cascade past the trigger)", async () => {
      const offeringId = await createDraft({ specs: 1, prices: 1 });
      await forceStatus(offeringId, "TESTING");

      const result = await deleteOffering(offeringId, {}, actorId);

      expect(result).toMatchObject({
        ok: true,
        specificationsRemoved: 1,
        pricesRemoved: 1,
      });
      expect(await offeringExists(offeringId)).toBe(false);
      expect(await specCountOf(offeringId)).toBe(0);
      expect(await priceCountOf(offeringId)).toBe(0);
    });

    it("refuses ACTIVE / OBSOLETE / RETIRED with OFFERING_NOT_DELETABLE and the observed status", async () => {
      for (const status of ["ACTIVE", "OBSOLETE", "RETIRED"] as const) {
        const offeringId = await createDraft({ specs: 1, prices: 1 });
        await forceStatus(offeringId, status);
        const result = await deleteOffering(offeringId, {}, actorId);
        expect(result).toEqual({
          ok: false,
          code: "OFFERING_NOT_DELETABLE",
          lifecycleStatus: status,
        });
        // Nothing was removed.
        expect(await offeringExists(offeringId)).toBe(true);
        expect(await specCountOf(offeringId)).toBe(1);
        expect(await priceCountOf(offeringId)).toBe(1);
      }
      expect(await deleteOffering(MISSING_ID, {}, actorId)).toEqual({
        ok: false,
        code: "OFFERING_NOT_FOUND",
      });
    });

    it("a direct SQL delete of an ACTIVE version's price is still refused by the trigger", async () => {
      const offeringId = await createDraft({ specs: 0, prices: 1 });
      await forceStatus(offeringId, "ACTIVE");
      await expect(
        sql`DELETE FROM product.product_offering_price WHERE product_offering_id = ${offeringId}`,
      ).rejects.toThrow(/product_child_write_requires_draft/);
    });

    it("deleting a branch leaves the root and the family graph intact, and frees the open-version index", async () => {
      // root v1 ACTIVE, branch v2 DRAFT (open).
      const rootId = await createDraft({ specs: 1, prices: 1 });
      await forceStatus(rootId, "ACTIVE");
      const { offeringId: branchId } = await db.transaction((tx) =>
        productOfferingRepository.branchOfferingAsDraft(tx, rootId),
      );

      const result = await deleteOffering(branchId, {}, actorId);
      expect(result).toMatchObject({
        ok: true,
        familyId: rootId,
        familyRemains: true,
      });

      // Root untouched; branch gone.
      expect(await offeringExists(rootId)).toBe(true);
      expect(await offeringExists(branchId)).toBe(false);
      const [root] = await db
        .select({
          status: productOffering.lifecycleStatus,
          family: productOffering.familyOfferingId,
        })
        .from(productOffering)
        .where(eq(productOffering.productOfferingId, rootId));
      expect(root?.status).toBe("ACTIVE");
      expect(root?.family).toBeNull();

      // The open-version slot is free again: a fresh branch can be created.
      const { offeringId: branch2 } = await db.transaction((tx) =>
        productOfferingRepository.branchOfferingAsDraft(tx, rootId),
      );
      expect(branch2).toBeTruthy();
    });

    it("deleting the family's only version leaves no orphan rows", async () => {
      const offeringId = await createDraft({ specs: 2, prices: 1 });
      const result = await deleteOffering(offeringId, {}, actorId);
      expect(result).toMatchObject({ ok: true, familyRemains: false });
      expect(await offeringExists(offeringId)).toBe(false);
      expect(await specCountOf(offeringId)).toBe(0);
      expect(await priceCountOf(offeringId)).toBe(0);
    });

    it("a pre-existing PRODUCT_OFFERING_DISCARDED audit row still resolves its category (D5)", async () => {
      await db.insert(auditLog).values({
        eventType: "PRODUCT_OFFERING_DISCARDED",
        actorUserId: actorId,
        targetEntity: "PRODUCT_OFFERING",
        targetId: "PRDOFR00000042",
        beforeData: { lifecycleStatus: "DRAFT" },
        afterData: { lifecycleStatus: "RETIRED" },
      });

      const page = await auditLogRepository.findFiltered(
        db,
        { eventType: null, actorUserId: null, dateFrom: null, dateTo: null },
        1,
        200,
      );
      // `eventType` no longer includes the removed type in the TS union, but the
      // DB row still carries the literal string — compare as string.
      const legacy = page.rows.find(
        (r) => (r.eventType as string) === "PRODUCT_OFFERING_DISCARDED",
      );
      expect(legacy).toBeDefined();
      // The legacy fallback (LEGACY_AUDIT_EVENT_CATEGORY_MAP) keeps the category
      // resolving to Removal rather than undefined, so the row still renders.
      expect(legacy?.category).toBe("Removal");
    });
  },
);
