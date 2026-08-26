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
    let goodOfferingId: string; // ACTIVE, billing-only, sellable; flat recurring + tiered usage prices

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
      prices?: "none" | "flat-and-tiered";
    }): Promise<string> {
      const [offering] = await db
        .insert(productOffering)
        .values({
          name: "PMORDVERIFY-Offering",
          isBundle: false,
          isSellable: opts.isSellable ?? true,
          billingOnly: opts.billingOnly ?? true,
          lifecycleStatus: opts.lifecycleStatus,
          version: 1,
          lastEditedBy: null,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      const offeringId = offering!.productOfferingId;

      if ((opts.prices ?? "flat-and-tiered") === "flat-and-tiered") {
        await db.insert(productOfferingPrice).values([
          {
            productOfferingId: offeringId,
            name: "Monthly Recurring Charge",
            priceType: "recurring",
            amount: "5000.00",
            currency: CURRENCY,
            pricingModel: "flat",
            startDateTime: new Date("2026-01-01T00:00:00Z"),
          },
          {
            productOfferingId: offeringId,
            name: "Data Overage",
            priceType: "usage",
            amount: null,
            currency: CURRENCY,
            pricingModel: "tiered",
            pricingCharacteristics: {
              tiers: [{ from: 0, to: null, rate: "0.05" }],
            },
            startDateTime: new Date("2026-01-01T00:00:00Z"),
          },
        ]);
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

      it("OVERRIDE_PRICE_TYPE_INVALID — override targets a tiered price type", async () => {
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
