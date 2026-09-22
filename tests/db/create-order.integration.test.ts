import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { productOffering, productOfferingPrice } from "@/db/schema/product";
import {
  orderItemPriceOverride,
  productOrder,
  productOrderItem,
} from "@/db/schema/ordering";
import {
  inventoryStatusHistory,
  productInventory,
} from "@/db/schema/inventory";
import { auditLog } from "@/db/schema/audit";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { BACKDATING_TOLERANCE_DAYS } from "@/validation/backdating-tolerance";
import type { createOrder as CreateOrder } from "@/services/ordering/create-order";
import type { CreateOrderInput } from "@/validation/ordering/create-order.schema";
import type {
  FlatFeeComponent,
  UsageRateComponent,
  CapacityCommitmentComponent,
  CapacityMotivationComponent,
} from "@/validation/product/pricing-component.schema";

// pm28-spec §4 — live-DB integration proof for `createOrder`. Standard path
// (atomic completion), override path (PENDING park), every §1 precondition
// error code, the TOCTOU re-check, and the crash-injection atomicity proof.
// `PMORDVERIFY-` prefix convention (pm28-spec verification checklist) is
// carried by every ad hoc name inserted below.
const databaseUrl = process.env.DATABASE_URL;

// Pinned so the fixture's flat recurring price (effective 2026-01-01) and the
// default start dates below stay inside the 3-day backdating tolerance.
const NOW = new Date("2026-08-10T00:00:00Z");
const CURRENCY = "MYR";

// pm50-spec D6 — component-envelope builders replacing the pre-reshape
// price-row literals, one per component type this file seeds. Same shape
// `db/seeds/demo/product-demo.ts`'s `buildPriceEnvelope` builds in production.
function flatFeeEnvelope(
  priceType: "recurring" | "oneTime",
  amount: string,
): FlatFeeComponent {
  return {
    "@type": "flat_fee",
    specVersion: 1,
    plaSpecId: null,
    priceType,
    appliesAt: "billing",
    basis: "flat",
    boundTo: null,
    params: { amount },
  };
}

function usageRateEnvelope(
  ratePerUnit: string,
  unitOfMeasure: "GB",
): UsageRateComponent {
  return {
    "@type": "usage_rate",
    specVersion: 1,
    plaSpecId: null,
    priceType: "usage",
    appliesAt: "rating",
    basis: "quantity",
    boundTo: { unitOfMeasure },
    params: { ratePerUnit, rateCardLookUp: null },
  };
}

function capacityCommitmentEnvelope(
  unitOfMeasure: "GB",
  committedQuantity: number,
): CapacityCommitmentComponent {
  return {
    "@type": "capacity_commitment",
    specVersion: 1,
    plaSpecId: "PLA_CAPACITY_COMMITMENT",
    priceType: "commitment",
    appliesAt: "post_aggregation",
    basis: "quantity",
    boundTo: { unitOfMeasure },
    params: { committedQuantity },
  };
}

function capacityMotivationEnvelope(
  unitOfMeasure: "GB",
): CapacityMotivationComponent {
  return {
    "@type": "capacity_motivation",
    specVersion: 1,
    plaSpecId: "PLA_CAPACITY_MOTIVATION",
    priceType: "discount",
    appliesAt: "post_aggregation",
    basis: "quantity",
    boundTo: { unitOfMeasure },
    params: { steps: [{ aboveQuantity: 1000, ratePerUnit: "0.01" }] },
  };
}

describe.skipIf(!databaseUrl)(
  "createOrder (pm28-spec §4, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql | undefined;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let createOrder: typeof CreateOrder;

    let actorId: string;
    let cycleId: string;

    // Good-path fixtures shared by the standard/override happy-path tests and
    // several precondition tests that only need one axis to be "bad."
    let goodPartyRoleId: string;
    let goodBanId: string;
    let goodOfferingId: string; // ACTIVE, billing-only, sellable; flat_fee(recurring) + capacity_motivation components

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

    async function newPartyRole(
      orgName: string,
      status: "ACTIVE" | "VALIDATED",
    ): Promise<string> {
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
          status,
          lastModifiedBy: actorId,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      return role!.partyRoleId;
    }

    async function newBillingAccount(
      partyRoleId: string,
      state: "active" | "closed" = "active",
    ): Promise<string> {
      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: "PMORDVERIFY-FA",
          refPartyRoleId: partyRoleId,
          currency: CURRENCY,
          lastEditedBy: actorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "PMORDVERIFY-BAN",
          state,
          refPartyRoleId: partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: cycleId,
          lastEditedBy: actorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    async function newOffering(opts: {
      lifecycleStatus: "DRAFT" | "ACTIVE" | "RETIRED";
      isSellable?: boolean;
      billingOnly?: boolean;
      prices?:
        | "none"
        | "flat-and-capacity"
        | "components-full"
        | "capacity-and-usage";
    }): Promise<string> {
      // Necessary pm50 deviation from D6's literal "change only the shape of
      // the seeded price rows": pm36's DRAFT-guard trigger
      // (`product_child_write_requires_draft`) refuses a price insert once
      // the parent offering leaves DRAFT, and this fixture previously
      // created the offering ACTIVE before pricing it — already flagged as
      // debt by pm36's own tracker note ("the trigger widens the option-C
      // co-land scope") but never actually fixed here. It must be fixed now:
      // no shape of price row is insertable at all otherwise, so "repair the
      // four suites" (D6) is unreachable without also reordering to
      // insert-while-DRAFT-then-activate (the same pattern pm36 itself gave
      // `db/seeds/demo/product-demo.ts`).
      const [offering] = await db
        .insert(productOffering)
        .values({
          name: "PMORDVERIFY-Offering",
          isBundle: false,
          isSellable: opts.isSellable ?? true,
          billingOnly: opts.billingOnly ?? true,
          lifecycleStatus: "DRAFT",
          version: 1,
          lastEditedBy: null,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      const offeringId = offering!.productOfferingId;

      const priceSet = opts.prices ?? "flat-and-capacity";

      if (priceSet === "flat-and-capacity") {
        // pm50-spec D6 — the flat recurring price is a byte-identical re-key
        // (same amount, currency, start date); the old tiered "Data Overage"
        // usage price is replaced with a capacity_motivation, which is the
        // new shape that is legitimately never an override target — keeping
        // this fixture's "not a valid override target" intent alive rather
        // than deleting the case. No `usage_rate` here on purpose: a `usage`
        // override against this offering must still resolve to nothing.
        await db.insert(productOfferingPrice).values([
          {
            productOfferingId: offeringId,
            name: "Monthly Recurring Charge",
            componentType: "flat_fee",
            priceComponent: flatFeeEnvelope("recurring", "5000.00"),
            recurringChargePeriodLength: 1,
            recurringChargePeriodType: "months",
            currency: CURRENCY,
            startDateTime: new Date("2026-01-01T00:00:00Z"),
          },
          {
            productOfferingId: offeringId,
            name: "Data Overage Motivation",
            componentType: "capacity_motivation",
            priceComponent: capacityMotivationEnvelope("GB"),
            unitOfMeasure: "GB",
            currency: CURRENCY,
            startDateTime: new Date("2026-01-01T00:00:00Z"),
          },
        ]);
      } else if (priceSet === "components-full") {
        // pm50-spec I4 — supports the usage/once override-resolution cases:
        // a flat_fee(recurring), a flat_fee(oneTime) and a usage_rate all on
        // one version. The two flat_fee rows need distinct start dates (both
        // carry `unit_of_measure = NULL`, and the reshaped uniqueness
        // constraint is NULLS-NOT-DISTINCT on
        // (offering, component_type, unit_of_measure, start_date_time) —
        // pm48's own fixture note).
        await db.insert(productOfferingPrice).values([
          {
            productOfferingId: offeringId,
            name: "Monthly Recurring Charge",
            componentType: "flat_fee",
            priceComponent: flatFeeEnvelope("recurring", "5000.00"),
            recurringChargePeriodLength: 1,
            recurringChargePeriodType: "months",
            currency: CURRENCY,
            startDateTime: new Date("2026-01-01T00:00:00Z"),
          },
          {
            productOfferingId: offeringId,
            name: "Activation Fee",
            componentType: "flat_fee",
            priceComponent: flatFeeEnvelope("oneTime", "250.00"),
            currency: CURRENCY,
            startDateTime: new Date("2026-01-02T00:00:00Z"),
          },
          {
            productOfferingId: offeringId,
            name: "Data Usage Rate",
            componentType: "usage_rate",
            priceComponent: usageRateEnvelope("0.05", "GB"),
            unitOfMeasure: "GB",
            currency: CURRENCY,
            startDateTime: new Date("2026-01-01T00:00:00Z"),
          },
        ]);
      } else if (priceSet === "capacity-and-usage") {
        // pm50-spec I4 — an offering carrying only capacity modifiers plus a
        // usage_rate (no flat_fee at all): a recurring override must be
        // refused (no flat_fee target), a usage override must be accepted.
        await db.insert(productOfferingPrice).values([
          {
            productOfferingId: offeringId,
            name: "Data Usage Rate",
            componentType: "usage_rate",
            priceComponent: usageRateEnvelope("0.05", "GB"),
            unitOfMeasure: "GB",
            currency: CURRENCY,
            startDateTime: new Date("2026-01-01T00:00:00Z"),
          },
          {
            productOfferingId: offeringId,
            name: "Commitment",
            componentType: "capacity_commitment",
            priceComponent: capacityCommitmentEnvelope("GB", 1000),
            unitOfMeasure: "GB",
            currency: CURRENCY,
            startDateTime: new Date("2026-01-01T00:00:00Z"),
          },
        ]);
      }

      if (opts.lifecycleStatus !== "DRAFT") {
        await db
          .update(productOffering)
          .set({ lifecycleStatus: opts.lifecycleStatus })
          .where(eq(productOffering.productOfferingId, offeringId));
      }

      return offeringId;
    }

    function baseInput(
      overrides: Partial<CreateOrderInput> = {},
    ): CreateOrderInput {
      return {
        customerPartyRoleId: goodPartyRoleId,
        billingAccountId: goodBanId,
        productOfferingId: goodOfferingId,
        quantity: 1,
        startDate: "2026-08-09",
        characteristics: { SST_ID: "01" },
        ...overrides,
      };
    }

    async function countOrdersFor(partyRoleId: string): Promise<number> {
      const [row] = await db
        .select({ total: count() })
        .from(productOrder)
        .where(eq(productOrder.customerPartyRoleId, partyRoleId));
      return row?.total ?? 0;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // Real service uses its own @/db/client pool — dynamic import after
      // confirming DATABASE_URL (ordering-read.integration precedent).
      const createOrderMod = await import("@/services/ordering/create-order");
      createOrder = createOrderMod.createOrder;

      actorId = await newAppUser("PMORDVERIFY Submitter");

      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "PMORDVERIFY Cycle", lastEditedBy: actorId })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;

      goodPartyRoleId = await newPartyRole("PMORDVERIFY-Good", "ACTIVE");
      goodBanId = await newBillingAccount(goodPartyRoleId, "active");
      goodOfferingId = await newOffering({ lifecycleStatus: "ACTIVE" });
    }, 60_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (!sql) return;
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    describe("standard path (no override)", () => {
      it("atomically completes the order and instantiates a subscription with 3 audit rows", async () => {
        const result = await createOrder(baseInput(), actorId, () => NOW);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.status).toBe("COMPLETED");
        expect(result.inventoryId).not.toBeNull();

        const [order] = await db
          .select()
          .from(productOrder)
          .where(eq(productOrder.productOrderId, result.orderId));
        expect(order?.status).toBe("COMPLETED");
        expect(order?.completedAt).not.toBeNull();

        const items = await db
          .select()
          .from(productOrderItem)
          .where(eq(productOrderItem.productOrderId, result.orderId));
        expect(items).toHaveLength(1);
        expect(items[0]!.orderedCharacteristics).toEqual({ SST_ID: "01" });

        const [inventory] = await db
          .select()
          .from(productInventory)
          .where(eq(productInventory.productInventoryId, result.inventoryId!));
        expect(inventory?.status).toBe("ACTIVE");
        expect(inventory?.instanceCharacteristics).toEqual({ SST_ID: "01" });

        const history = await db
          .select()
          .from(inventoryStatusHistory)
          .where(
            eq(inventoryStatusHistory.productInventoryId, result.inventoryId!),
          );
        expect(history).toHaveLength(1);
        expect(history[0]!.fromStatus).toBeNull();
        expect(history[0]!.toStatus).toBe("ACTIVE");

        const orderAudits = await db
          .select({ eventType: auditLog.eventType })
          .from(auditLog)
          .where(eq(auditLog.targetId, result.orderId));
        expect(orderAudits.map((a) => a.eventType).sort()).toEqual(
          ["PRODUCT_ORDER_COMPLETED", "PRODUCT_ORDER_CREATED"].sort(),
        );

        const inventoryAudits = await db
          .select({ eventType: auditLog.eventType })
          .from(auditLog)
          .where(eq(auditLog.targetId, result.inventoryId!));
        expect(inventoryAudits.map((a) => a.eventType)).toEqual([
          "PRODUCT_INVENTORY_CREATED",
        ]);
      });
    });

    describe("override path", () => {
      it("commits as PENDING with the override row, zero inventory, zero COMPLETED audit", async () => {
        const result = await createOrder(
          baseInput({
            overrides: [
              { priceType: "recurring", amount: "420.00", currency: CURRENCY },
            ],
          }),
          actorId,
          () => NOW,
        );
        expect(result).toMatchObject({
          ok: true,
          status: "PENDING",
          inventoryId: null,
        });
        if (!result.ok) return;

        const [order] = await db
          .select()
          .from(productOrder)
          .where(eq(productOrder.productOrderId, result.orderId));
        expect(order?.status).toBe("PENDING");
        expect(order?.completedAt).toBeNull();

        const [item] = await db
          .select({ id: productOrderItem.productOrderItemId })
          .from(productOrderItem)
          .where(eq(productOrderItem.productOrderId, result.orderId));
        expect(item).toBeDefined();

        const overrideRows = await db
          .select()
          .from(orderItemPriceOverride)
          .where(eq(orderItemPriceOverride.productOrderItemId, item!.id));
        expect(overrideRows).toHaveLength(1);
        expect(overrideRows[0]!.amount).toBe("420.00");

        const inventoryRows = await db
          .select({ id: productInventory.productInventoryId })
          .from(productInventory)
          .where(eq(productInventory.productOrderItemId, item!.id));
        expect(inventoryRows).toHaveLength(0);

        const audits = await db
          .select({ eventType: auditLog.eventType })
          .from(auditLog)
          .where(eq(auditLog.targetId, result.orderId));
        const eventTypes = audits.map((a) => a.eventType).sort();
        expect(eventTypes).toEqual(
          ["PRODUCT_ORDER_CREATED", "PRODUCT_ORDER_PENDING_APPROVAL"].sort(),
        );
        expect(eventTypes).not.toContain("PRODUCT_ORDER_COMPLETED");
      });
    });

    describe("override target resolution (pm50-spec D2/I4)", () => {
      it("resolves a usage override against a usage_rate component and validates", async () => {
        const offeringId = await newOffering({
          lifecycleStatus: "ACTIVE",
          prices: "components-full",
        });
        const result = await createOrder(
          baseInput({
            productOfferingId: offeringId,
            overrides: [
              { priceType: "usage", amount: "0.03", currency: CURRENCY },
            ],
          }),
          actorId,
          () => NOW,
        );
        expect(result.ok).toBe(true);
      });

      it("resolves a once override against a oneTime flat_fee component and validates", async () => {
        const offeringId = await newOffering({
          lifecycleStatus: "ACTIVE",
          prices: "components-full",
        });
        const result = await createOrder(
          baseInput({
            productOfferingId: offeringId,
            overrides: [
              { priceType: "once", amount: "200.00", currency: CURRENCY },
            ],
          }),
          actorId,
          () => NOW,
        );
        expect(result.ok).toBe(true);
      });

      it("an offering with only capacity modifiers + a usage_rate: recurring override refused, usage override accepted", async () => {
        const offeringId = await newOffering({
          lifecycleStatus: "ACTIVE",
          prices: "capacity-and-usage",
        });

        const recurringResult = await createOrder(
          baseInput({
            productOfferingId: offeringId,
            overrides: [
              { priceType: "recurring", amount: "10.00", currency: CURRENCY },
            ],
          }),
          actorId,
          () => NOW,
        );
        expect(recurringResult).toEqual({
          ok: false,
          code: "OVERRIDE_PRICE_TYPE_INVALID",
        });

        const usageResult = await createOrder(
          baseInput({
            productOfferingId: offeringId,
            overrides: [
              { priceType: "usage", amount: "0.03", currency: CURRENCY },
            ],
          }),
          actorId,
          () => NOW,
        );
        expect(usageResult.ok).toBe(true);
      });
    });

    describe("precondition error codes (pm28-spec §1)", () => {
      it("CUSTOMER_NOT_ACTIVE — VALIDATED party", async () => {
        const validatedPartyRoleId = await newPartyRole(
          "PMORDVERIFY-Validated",
          "VALIDATED",
        );
        const banId = await newBillingAccount(validatedPartyRoleId, "active");
        const before = await countOrdersFor(validatedPartyRoleId);

        const result = await createOrder(
          baseInput({
            customerPartyRoleId: validatedPartyRoleId,
            billingAccountId: banId,
          }),
          actorId,
          () => NOW,
        );
        expect(result).toEqual({ ok: false, code: "CUSTOMER_NOT_ACTIVE" });
        expect(await countOrdersFor(validatedPartyRoleId)).toBe(before);
      });

      it("BILLING_ACCOUNT_CLOSED — closed BAN", async () => {
        const closedBanId = await newBillingAccount(goodPartyRoleId, "closed");
        const before = await countOrdersFor(goodPartyRoleId);

        const result = await createOrder(
          baseInput({ billingAccountId: closedBanId }),
          actorId,
          () => NOW,
        );
        expect(result).toEqual({ ok: false, code: "BILLING_ACCOUNT_CLOSED" });
        expect(await countOrdersFor(goodPartyRoleId)).toBe(before);
      });

      it("BILLING_ACCOUNT_MISMATCH — BAN belongs to a different party", async () => {
        const otherPartyRoleId = await newPartyRole(
          "PMORDVERIFY-Other",
          "ACTIVE",
        );
        const otherBanId = await newBillingAccount(otherPartyRoleId, "active");
        const before = await countOrdersFor(goodPartyRoleId);

        const result = await createOrder(
          baseInput({ billingAccountId: otherBanId }),
          actorId,
          () => NOW,
        );
        expect(result).toEqual({ ok: false, code: "BILLING_ACCOUNT_MISMATCH" });
        expect(await countOrdersFor(goodPartyRoleId)).toBe(before);
      });

      it("OFFERING_NOT_ORDERABLE — DRAFT offering", async () => {
        const draftOfferingId = await newOffering({ lifecycleStatus: "DRAFT" });
        const before = await countOrdersFor(goodPartyRoleId);

        const result = await createOrder(
          baseInput({ productOfferingId: draftOfferingId }),
          actorId,
          () => NOW,
        );
        expect(result).toEqual({ ok: false, code: "OFFERING_NOT_ORDERABLE" });
        expect(await countOrdersFor(goodPartyRoleId)).toBe(before);
      });

      it("OFFERING_NOT_ORDERABLE — non-sellable ACTIVE offering", async () => {
        const nonSellableOfferingId = await newOffering({
          lifecycleStatus: "ACTIVE",
          isSellable: false,
        });
        const before = await countOrdersFor(goodPartyRoleId);

        const result = await createOrder(
          baseInput({ productOfferingId: nonSellableOfferingId }),
          actorId,
          () => NOW,
        );
        expect(result).toEqual({ ok: false, code: "OFFERING_NOT_ORDERABLE" });
        expect(await countOrdersFor(goodPartyRoleId)).toBe(before);
      });

      it("NO_PRICE_ROWS — ACTIVE, orderable offering with zero price rows", async () => {
        const noPriceOfferingId = await newOffering({
          lifecycleStatus: "ACTIVE",
          prices: "none",
        });
        const before = await countOrdersFor(goodPartyRoleId);

        const result = await createOrder(
          baseInput({ productOfferingId: noPriceOfferingId }),
          actorId,
          () => NOW,
        );
        expect(result).toEqual({ ok: false, code: "NO_PRICE_ROWS" });
        expect(await countOrdersFor(goodPartyRoleId)).toBe(before);
      });

      it("OVERRIDE_PRICE_TYPE_INVALID — override targets a component absent on the pinned version", async () => {
        const before = await countOrdersFor(goodPartyRoleId);

        const result = await createOrder(
          baseInput({
            overrides: [
              { priceType: "usage", amount: "1.00", currency: CURRENCY },
            ],
          }),
          actorId,
          () => NOW,
        );
        expect(result).toEqual({
          ok: false,
          code: "OVERRIDE_PRICE_TYPE_INVALID",
        });
        expect(await countOrdersFor(goodPartyRoleId)).toBe(before);
      });

      it("OVERRIDE_CURRENCY_MISMATCH — override currency differs from the BAN's", async () => {
        const before = await countOrdersFor(goodPartyRoleId);

        const result = await createOrder(
          baseInput({
            overrides: [
              { priceType: "recurring", amount: "420.00", currency: "USD" },
            ],
          }),
          actorId,
          () => NOW,
        );
        expect(result).toEqual({
          ok: false,
          code: "OVERRIDE_CURRENCY_MISMATCH",
        });
        expect(await countOrdersFor(goodPartyRoleId)).toBe(before);
      });

      it("BACKDATED_START_TOO_FAR — start date more than 3 days before now", async () => {
        const before = await countOrdersFor(goodPartyRoleId);

        const result = await createOrder(
          baseInput({ startDate: "2026-08-06" }), // 4 days before the pinned NOW
          actorId,
          () => NOW,
        );
        expect(result).toEqual({ ok: false, code: "BACKDATED_START_TOO_FAR" });
        expect(await countOrdersFor(goodPartyRoleId)).toBe(before);
      });

      it("accepts a start date exactly BACKDATING_TOLERANCE_DAYS before now (inclusive boundary)", async () => {
        const before = await countOrdersFor(goodPartyRoleId);

        const boundary = new Date(NOW);
        boundary.setUTCDate(boundary.getUTCDate() - BACKDATING_TOLERANCE_DAYS);
        const startDate = boundary.toISOString().slice(0, 10); // exactly the tolerance, still allowed

        const result = await createOrder(
          baseInput({ startDate }),
          actorId,
          () => NOW,
        );

        expect(result.ok).toBe(true);
        expect(await countOrdersFor(goodPartyRoleId)).toBe(before + 1);
      });
    });

    describe("TOCTOU (architecture Inv. #19)", () => {
      it("a party flipped SUSPENDED between form-read and submit fails CUSTOMER_NOT_ACTIVE, no rows persist", async () => {
        const toctouPartyRoleId = await newPartyRole(
          "PMORDVERIFY-Toctou",
          "ACTIVE",
        );
        const toctouBanId = await newBillingAccount(
          toctouPartyRoleId,
          "active",
        );

        // Simulates the "form read ACTIVE, then a concurrent transaction
        // flips the party" race — the input below still names this party, as
        // if the form had been read before the flip below.
        await db
          .update(partyRole)
          .set({ status: "SUSPENDED" })
          .where(eq(partyRole.partyRoleId, toctouPartyRoleId));

        const result = await createOrder(
          baseInput({
            customerPartyRoleId: toctouPartyRoleId,
            billingAccountId: toctouBanId,
          }),
          actorId,
          () => NOW,
        );
        expect(result).toEqual({ ok: false, code: "CUSTOMER_NOT_ACTIVE" });
        expect(await countOrdersFor(toctouPartyRoleId)).toBe(0);
      });
    });

    describe("crash-injection atomicity (pm28-spec §4)", () => {
      it("an unexpected repo error after the order insert rolls back the entire order — no partial state", async () => {
        const crashPartyRoleId = await newPartyRole(
          "PMORDVERIFY-Crash",
          "ACTIVE",
        );
        const crashBanId = await newBillingAccount(crashPartyRoleId, "active");

        vi.spyOn(
          productInventoryRepository,
          "insertInventory",
        ).mockRejectedValueOnce(
          new Error("PMORDVERIFY simulated crash between item and inventory"),
        );

        await expect(
          createOrder(
            baseInput({
              customerPartyRoleId: crashPartyRoleId,
              billingAccountId: crashBanId,
            }),
            actorId,
            () => NOW,
          ),
        ).rejects.toThrow("PMORDVERIFY simulated crash");

        expect(await countOrdersFor(crashPartyRoleId)).toBe(0);

        const items = await db
          .select({ id: productOrderItem.productOrderItemId })
          .from(productOrderItem)
          .innerJoin(
            productOrder,
            eq(productOrder.productOrderId, productOrderItem.productOrderId),
          )
          .where(eq(productOrder.customerPartyRoleId, crashPartyRoleId));
        expect(items).toHaveLength(0);

        const inventoryRows = await db
          .select({ id: productInventory.productInventoryId })
          .from(productInventory)
          .where(eq(productInventory.customerPartyRoleId, crashPartyRoleId));
        expect(inventoryRows).toHaveLength(0);
      });
    });
  },
);
