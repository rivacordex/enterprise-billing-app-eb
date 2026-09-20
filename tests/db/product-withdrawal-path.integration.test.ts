import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import {
  productOffering,
  productOfferingPrice,
  productSpecifications,
} from "@/db/schema/product";
import { productInventory } from "@/db/schema/inventory";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { LifecycleStatus } from "@/types/product";
import type { ProductStatus } from "@/types/inventory";
import type { obsoleteOffering as ObsoleteOffering } from "@/services/product/obsolete-offering";
import type { retireOffering as RetireOffering } from "@/services/product/retire-offering";
import type { getLiveSubscriptionCount as GetLiveSubscriptionCount } from "@/services/product/get-live-subscription-count";
import type { createOrder as CreateOrder } from "@/services/ordering/create-order";
import type { getOrderDetail as GetOrderDetail } from "@/services/ordering/get-order-detail";
import type { CreateOrderInput } from "@/validation/ordering/create-order.schema";

// pm43-spec I9. Live-DB proof of the withdrawal path: ACTIVE → OBSOLETE (stop
// selling) and OBSOLETE → RETIRED behind the subscription gate. The gate blocks
// while any subscription is not TERMINATED, or is TERMINATED with an end_date
// today or later (inclusive-billed, Inv. #21); the returned liveCount matches;
// retiring succeeds at zero; a pinned version's prices resolve identically before
// and after both transitions (Inv. #17). Subscriptions are instantiated through
// the real createOrder service; their status/end_date are then adjusted directly
// (a fixture shortcut) to exercise each gate branch.
const databaseUrl = process.env.DATABASE_URL;
const CURRENCY = "MYR";
const NOW = new Date("2026-08-10T00:00:00Z");
const ORDER_START = "2026-08-09";

describe.skipIf(!databaseUrl)(
  "product withdrawal path (requires DATABASE_URL)",
  () => {
    let sql2: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let obsoleteOffering: typeof ObsoleteOffering;
    let retireOffering: typeof RetireOffering;
    let getLiveSubscriptionCount: typeof GetLiveSubscriptionCount;
    let createOrder: typeof CreateOrder;
    let getOrderDetail: typeof GetOrderDetail;
    let actorId: string;
    let partyRoleId: string;
    let banId: string;
    let uniqueCounter = 0;

    async function newAppUser(name: string): Promise<string> {
      const [row] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: name,
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      return row!.id;
    }

    async function newPartyRole(orgName: string): Promise<string> {
      const [org] = await db
        .insert(organization)
        .values({
          name: orgName,
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: actorId,
        })
        .returning({ organizationId: organization.organizationId });
      const [role] = await db
        .insert(partyRole)
        .values({
          engagedParty: org!.organizationId,
          status: "ACTIVE",
          lastModifiedBy: actorId,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      return role!.partyRoleId;
    }

    async function newBillingAccount(roleId: string): Promise<string> {
      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: "PMWD-FA",
          refPartyRoleId: roleId,
          currency: CURRENCY,
          lastEditedBy: actorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [cycle] = await db
        .insert(billCycle)
        .values({
          name: `PMWD Cycle ${(uniqueCounter += 1)}`,
          lastEditedBy: actorId,
        })
        .returning({ billCycleId: billCycle.billCycleId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "PMWD-BAN",
          state: "active",
          refPartyRoleId: roleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: cycle!.billCycleId,
          lastEditedBy: actorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    // An ACTIVE, orderable offering with a resolved mandatory spec and a complete
    // recurring price. Children are inserted while DRAFT (pm36 trigger), then the
    // parent is flipped ACTIVE directly (a fixture shortcut, not the release path).
    async function newActiveOffering(): Promise<string> {
      uniqueCounter += 1;
      const [offering] = await db
        .insert(productOffering)
        .values({
          name: `PMWD-Offering-${uniqueCounter}`,
          isBundle: false,
          isSellable: true,
          billingOnly: true,
          lifecycleStatus: "DRAFT",
          version: 1,
          familyOfferingId: null,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      const offeringId = offering!.productOfferingId;

      await db.insert(productSpecifications).values({
        refProductOfferingId: offeringId,
        name: "SST identifier",
        isMandatory: true,
        isDefault: true,
        defaultValue: "01",
        productSpecCharacteristics: { SST_ID: "01" },
      });
      await db.insert(productOfferingPrice).values({
        productOfferingId: offeringId,
        name: "Monthly Recurring Charge",
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        amount: "5000.00",
        currency: CURRENCY,
        pricingModel: "flat",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
      });
      await db
        .update(productOffering)
        .set({ lifecycleStatus: "ACTIVE" })
        .where(eq(productOffering.productOfferingId, offeringId));
      return offeringId;
    }

    // Instantiates a real subscription against an ACTIVE offering, then adjusts
    // its status/end_date directly to place it in the gate branch under test.
    async function newSubscription(
      offeringId: string,
      adjust?: {
        status: ProductStatus;
        endDate?: "today" | "tomorrow" | "yesterday";
      },
    ): Promise<string> {
      const orderInput: CreateOrderInput = {
        customerPartyRoleId: partyRoleId,
        billingAccountId: banId,
        productOfferingId: offeringId,
        quantity: 1,
        startDate: ORDER_START,
        characteristics: { SST_ID: "01" },
      };
      const result = await createOrder(orderInput, actorId, () => NOW);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("createOrder failed in fixture");
      const inventoryId = result.inventoryId!;

      if (adjust) {
        const endDateSql =
          adjust.endDate === "today"
            ? sql`current_date`
            : adjust.endDate === "tomorrow"
              ? sql`current_date + 1`
              : adjust.endDate === "yesterday"
                ? sql`current_date - 1`
                : null;
        await db
          .update(productInventory)
          .set({
            status: adjust.status,
            ...(endDateSql ? { endDate: endDateSql } : {}),
          })
          .where(eq(productInventory.productInventoryId, inventoryId));
      }
      return inventoryId;
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

    // ACTIVE offering → obsolete it → the OBSOLETE offering id, ready to retire.
    async function newObsoleteOffering(): Promise<string> {
      const offeringId = await newActiveOffering();
      const result = await obsoleteOffering(offeringId, {}, actorId);
      expect(result.ok).toBe(true);
      return offeringId;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql2 = postgres(databaseUrl as string, { max: 4 });
      for (const s of [
        "inventory",
        "ordering",
        "billing",
        "customer",
        "product",
        "rating",
        "core",
        "drizzle",
      ]) {
        await sql2.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
      db = drizzle(sql2, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      const [obsoleteMod, retireMod, countMod, createOrderMod, orderDetailMod] =
        await Promise.all([
          import("@/services/product/obsolete-offering"),
          import("@/services/product/retire-offering"),
          import("@/services/product/get-live-subscription-count"),
          import("@/services/ordering/create-order"),
          import("@/services/ordering/get-order-detail"),
        ]);
      obsoleteOffering = obsoleteMod.obsoleteOffering;
      retireOffering = retireMod.retireOffering;
      getLiveSubscriptionCount = countMod.getLiveSubscriptionCount;
      createOrder = createOrderMod.createOrder;
      getOrderDetail = orderDetailMod.getOrderDetail;

      actorId = await newAppUser("PMWD Manager");
      partyRoleId = await newPartyRole("PMWD-Customer");
      banId = await newBillingAccount(partyRoleId);
    }, 60_000);

    afterAll(async () => {
      if (!sql2) return;
      for (const s of [
        "inventory",
        "ordering",
        "billing",
        "customer",
        "product",
        "rating",
        "core",
        "drizzle",
      ]) {
        await sql2.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
      await sql2.end();
    });

    const MISSING_ID = "PRDOFR99999999";

    // --- Stop selling ----------------------------------------------------

    it("ACTIVE → OBSOLETE succeeds and writes one OBSOLETED audit row", async () => {
      const offeringId = await newActiveOffering();
      const result = await obsoleteOffering(
        offeringId,
        { reason: "EOL" },
        actorId,
      );

      expect(result).toEqual({ ok: true, offeringId });
      expect(await statusOf(offeringId)).toBe("OBSOLETE");
      expect(await auditCount(offeringId, "PRODUCT_OFFERING_OBSOLETED")).toBe(
        1,
      );
    });

    it("stop selling is refused from every non-ACTIVE status (OFFERING_NOT_ACTIVE)", async () => {
      for (const status of [
        "DRAFT",
        "TESTING",
        "OBSOLETE",
        "RETIRED",
      ] as const) {
        const offeringId = await newActiveOffering();
        await forceStatus(offeringId, status);
        const result = await obsoleteOffering(offeringId, {}, actorId);
        expect(result).toEqual({ ok: false, code: "OFFERING_NOT_ACTIVE" });
      }
      expect(await obsoleteOffering(MISSING_ID, {}, actorId)).toEqual({
        ok: false,
        code: "OFFERING_NOT_FOUND",
      });
    });

    // --- Retire: predecessor guard --------------------------------------

    it("retire is refused from every non-OBSOLETE status (OFFERING_NOT_OBSOLETE)", async () => {
      for (const status of ["DRAFT", "TESTING", "ACTIVE", "RETIRED"] as const) {
        const offeringId = await newActiveOffering();
        await forceStatus(offeringId, status);
        const result = await retireOffering(offeringId, {}, actorId);
        expect(result).toEqual({ ok: false, code: "OFFERING_NOT_OBSOLETE" });
      }
      expect(await retireOffering(MISSING_ID, {}, actorId)).toEqual({
        ok: false,
        code: "OFFERING_NOT_FOUND",
      });
    });

    // --- Retire: subscription gate --------------------------------------

    it("OBSOLETE → RETIRED succeeds at zero live subscriptions, recording the observed count", async () => {
      const offeringId = await newObsoleteOffering();
      const result = await retireOffering(
        offeringId,
        { reason: "done" },
        actorId,
      );

      expect(result).toEqual({ ok: true, offeringId });
      expect(await statusOf(offeringId)).toBe("RETIRED");
      expect(await auditCount(offeringId, "PRODUCT_OFFERING_RETIRED")).toBe(1);

      const [event] = await db
        .select({ afterData: auditLog.afterData })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetId, offeringId),
            eq(auditLog.eventType, "PRODUCT_OFFERING_RETIRED"),
          ),
        );
      expect(
        (event?.afterData as { liveSubscriptionCount?: number })
          .liveSubscriptionCount,
      ).toBe(0);
    });

    it.each([
      ["an ACTIVE subscription", { status: "ACTIVE" as ProductStatus }],
      ["a SUSPENDED subscription", { status: "SUSPENDED" as ProductStatus }],
      [
        "a TERMINATED subscription ending today",
        { status: "TERMINATED" as ProductStatus, endDate: "today" as const },
      ],
      [
        "a TERMINATED subscription ending in the future",
        { status: "TERMINATED" as ProductStatus, endDate: "tomorrow" as const },
      ],
    ])("retire is blocked by %s", async (_label, adjust) => {
      const offeringId = await newActiveOffering();
      await newSubscription(offeringId, adjust);
      await obsoleteOffering(offeringId, {}, actorId);

      expect(await getLiveSubscriptionCount(offeringId)).toBe(1);
      const result = await retireOffering(offeringId, {}, actorId);
      expect(result).toEqual({
        ok: false,
        code: "RETIRE_BLOCKED_BY_SUBSCRIPTIONS",
        liveCount: 1,
      });
      expect(await statusOf(offeringId)).toBe("OBSOLETE");
    });

    it("retire is allowed once the only subscription is TERMINATED with a past end_date", async () => {
      const offeringId = await newActiveOffering();
      await newSubscription(offeringId, {
        status: "TERMINATED",
        endDate: "yesterday",
      });
      await obsoleteOffering(offeringId, {}, actorId);

      expect(await getLiveSubscriptionCount(offeringId)).toBe(0);
      const result = await retireOffering(offeringId, {}, actorId);
      expect(result).toEqual({ ok: true, offeringId });
      expect(await statusOf(offeringId)).toBe("RETIRED");
    });

    it("the blocked liveCount matches the number of still-live subscriptions", async () => {
      const offeringId = await newActiveOffering();
      await newSubscription(offeringId, { status: "ACTIVE" });
      await newSubscription(offeringId, { status: "SUSPENDED" });
      // A TERMINATED-in-the-past subscription does not count.
      await newSubscription(offeringId, {
        status: "TERMINATED",
        endDate: "yesterday",
      });
      await obsoleteOffering(offeringId, {}, actorId);

      expect(await getLiveSubscriptionCount(offeringId)).toBe(2);
      const result = await retireOffering(offeringId, {}, actorId);
      expect(result).toEqual({
        ok: false,
        code: "RETIRE_BLOCKED_BY_SUBSCRIPTIONS",
        liveCount: 2,
      });
    });

    // --- Grandfathering / Inv. #17 --------------------------------------

    it("a pinned subscription resolves identical prices before obsolete, after obsolete, and after retire", async () => {
      const offeringId = await newActiveOffering();
      const orderInput: CreateOrderInput = {
        customerPartyRoleId: partyRoleId,
        billingAccountId: banId,
        productOfferingId: offeringId,
        quantity: 1,
        startDate: ORDER_START,
        characteristics: { SST_ID: "01" },
      };
      const order = await createOrder(orderInput, actorId, () => NOW);
      expect(order.ok).toBe(true);
      if (!order.ok) return;

      const before = await getOrderDetail(order.orderId, NOW);

      await obsoleteOffering(offeringId, {}, actorId);
      const afterObsolete = await getOrderDetail(order.orderId, NOW);
      expect(afterObsolete!.prices).toEqual(before!.prices);
      expect(afterObsolete!.item.productOfferingId).toBe(offeringId);

      // Terminate the subscription in the past so the gate opens, then retire.
      await db
        .update(productInventory)
        .set({ status: "TERMINATED", endDate: sql`current_date - 1` })
        .where(eq(productInventory.productOfferingId, offeringId));
      const retired = await retireOffering(offeringId, {}, actorId);
      expect(retired.ok).toBe(true);

      const afterRetire = await getOrderDetail(order.orderId, NOW);
      expect(afterRetire!.prices).toEqual(before!.prices);
      expect(afterRetire!.item.productOfferingId).toBe(offeringId);
    });

    // --- Concurrency / orphan prevention --------------------------------

    it("two concurrent retires of one OBSOLETE version: exactly one wins", async () => {
      const offeringId = await newObsoleteOffering();

      const [r1, r2] = await Promise.all([
        retireOffering(offeringId, {}, actorId),
        retireOffering(offeringId, {}, actorId),
      ]);

      const wins = [r1, r2].filter((r) => r.ok);
      expect(wins).toHaveLength(1);
      const losers = [r1, r2].filter((r) => !r.ok);
      expect(losers).toHaveLength(1);
      // The loser's status re-read (locked) sees RETIRED, so it is refused.
      expect(losers[0]).toEqual({ ok: false, code: "OFFERING_NOT_OBSOLETE" });
      expect(await statusOf(offeringId)).toBe("RETIRED");
      expect(await auditCount(offeringId, "PRODUCT_OFFERING_RETIRED")).toBe(1);
    });

    it("no new subscription can be orphaned onto a withdrawn version — createOrder is refused once OBSOLETE", async () => {
      const offeringId = await newObsoleteOffering();
      const result = await createOrder(
        {
          customerPartyRoleId: partyRoleId,
          billingAccountId: banId,
          productOfferingId: offeringId,
          quantity: 1,
          startDate: ORDER_START,
          characteristics: { SST_ID: "01" },
        },
        actorId,
        () => NOW,
      );
      expect(result.ok).toBe(false);
    });
  },
);
