import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
import { productOrderRepository } from "@/db/repositories/ordering/product-order.repository";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import { inventoryStatusHistoryRepository } from "@/db/repositories/inventory/inventory-status-history.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { getOrderDetail as GetOrderDetail } from "@/services/ordering/get-order-detail";
import type { listOrders as ListOrders } from "@/services/ordering/list-orders";

const databaseUrl = process.env.DATABASE_URL;

// The read date the sample story resolves prices against — inside the recurring
// price's `[2026-01-01, 2027-01-01)` window, so the 5000.00 row is current and
// the 5500.00 successor is future (pm26-spec §4, Inv. #17).
const NOW = new Date("2026-08-10T00:00:00Z");
const CURRENCY = "MYR";
const CHARACTERISTICS = { SST_ID: "01", SD_ID: "A0C4E2" };

describe.skipIf(!databaseUrl)(
  "ordering read repositories + services (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql | undefined;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let getOrderDetail: typeof GetOrderDetail;
    let listOrders: typeof ListOrders;

    let submitterId: string;
    let reviewerId: string;
    let partyRoleId: string;
    let bannId: string;
    let offeringId: string;
    let order1Id: string; // COMPLETED + recurring override 420.00
    let order2Id: string; // standard COMPLETED, no override
    let order3Id: string; // PENDING + recurring override 399.00
    let order4Id: string; // REJECTED
    let item1Id: string;

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

    async function createOrderWithItem(order: {
      status: "COMPLETED" | "PENDING" | "REJECTED";
      reviewedBy: string | null;
      reviewedAt: Date | null;
      completedAt: Date | null;
      submittedAt: Date;
      startDate: string;
    }): Promise<{ orderId: string; itemId: string }> {
      const [insertedOrder] = await db
        .insert(productOrder)
        .values({
          customerPartyRoleId: partyRoleId,
          billingAccountId: bannId,
          status: order.status,
          submittedBy: submitterId,
          submittedAt: order.submittedAt,
          reviewedBy: order.reviewedBy,
          reviewedAt: order.reviewedAt,
          completedAt: order.completedAt,
        })
        .returning({ productOrderId: productOrder.productOrderId });
      const [insertedItem] = await db
        .insert(productOrderItem)
        .values({
          productOrderId: insertedOrder!.productOrderId,
          productOfferingId: offeringId,
          quantity: 1,
          startDate: order.startDate,
          orderedCharacteristics: CHARACTERISTICS,
        })
        .returning({ productOrderItemId: productOrderItem.productOrderItemId });
      return {
        orderId: insertedOrder!.productOrderId,
        itemId: insertedItem!.productOrderItemId,
      };
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // Real services use their own @/db/client pool — dynamic import after
      // confirming DATABASE_URL (product-repositories.integration precedent).
      const [getOrderDetailMod, listOrdersMod] = await Promise.all([
        import("@/services/ordering/get-order-detail"),
        import("@/services/ordering/list-orders"),
      ]);
      getOrderDetail = getOrderDetailMod.getOrderDetail;
      listOrders = listOrdersMod.listOrders;

      submitterId = await newAppUser("Order Submitter");
      reviewerId = await newAppUser("Order Reviewer");

      const [org] = await db
        .insert(organization)
        .values({
          name: "Sample Telecom",
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: submitterId,
        })
        .returning({ organizationId: organization.organizationId });
      const [role] = await db
        .insert(partyRole)
        .values({
          engagedParty: org!.organizationId,
          status: "ACTIVE",
          lastModifiedBy: submitterId,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      partyRoleId = role!.partyRoleId;

      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "Read Test Cycle", lastEditedBy: submitterId })
        .returning({ billCycleId: billCycle.billCycleId });
      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: "Read Test FA",
          refPartyRoleId: partyRoleId,
          currency: CURRENCY,
          lastEditedBy: submitterId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "Read Test BAN",
          refPartyRoleId: partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: cycle!.billCycleId,
          lastEditedBy: submitterId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      bannId = ban!.billingAccountId;

      const [offering] = await db
        .insert(productOffering)
        .values({
          name: "Enterprise SIP Trunk",
          isBundle: false,
          isSellable: true,
          billingOnly: true,
          lifecycleStatus: "ACTIVE",
          version: 2,
          lastEditedBy: null,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      offeringId = offering!.productOfferingId;

      // recurring 5000 (current) + its future 5500 successor, once 1000, usage
      // tiered — mirrors the seed offering's price shape.
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
          name: "Monthly Recurring Charge 2027",
          priceType: "recurring",
          amount: "5500.00",
          currency: CURRENCY,
          pricingModel: "flat",
          startDateTime: new Date("2027-01-01T00:00:00Z"),
        },
        {
          productOfferingId: offeringId,
          name: "Activation Fee",
          priceType: "once",
          amount: "1000.00",
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

      // 1) COMPLETED + recurring override 420.00 (+ ACTIVE inventory story).
      const o1 = await createOrderWithItem({
        status: "COMPLETED",
        reviewedBy: reviewerId,
        reviewedAt: new Date("2026-02-25T09:00:00Z"),
        completedAt: new Date("2026-03-01T00:00:00Z"),
        submittedAt: new Date("2026-02-24T09:00:00Z"),
        startDate: "2026-03-01",
      });
      order1Id = o1.orderId;
      item1Id = o1.itemId;
      await db.insert(orderItemPriceOverride).values({
        productOrderItemId: item1Id,
        priceType: "recurring",
        amount: "420.00",
        currency: CURRENCY,
      });

      // 2) standard COMPLETED, no override.
      const o2 = await createOrderWithItem({
        status: "COMPLETED",
        reviewedBy: null,
        reviewedAt: null,
        completedAt: new Date("2026-02-01T00:00:00Z"),
        submittedAt: new Date("2026-01-31T09:00:00Z"),
        startDate: "2026-02-01",
      });
      order2Id = o2.orderId;

      // 3) PENDING + recurring override 399.00, no inventory.
      const o3 = await createOrderWithItem({
        status: "PENDING",
        reviewedBy: null,
        reviewedAt: null,
        completedAt: null,
        submittedAt: new Date("2026-08-01T09:00:00Z"),
        startDate: "2026-09-01",
      });
      order3Id = o3.orderId;
      await db.insert(orderItemPriceOverride).values({
        productOrderItemId: o3.itemId,
        priceType: "recurring",
        amount: "399.00",
        currency: CURRENCY,
      });

      // 4) REJECTED.
      const o4 = await createOrderWithItem({
        status: "REJECTED",
        reviewedBy: reviewerId,
        reviewedAt: new Date("2026-08-02T09:00:00Z"),
        completedAt: null,
        submittedAt: new Date("2026-08-01T10:00:00Z"),
        startDate: "2026-09-01",
      });
      order4Id = o4.orderId;
    }, 30_000);

    afterAll(async () => {
      // If beforeAll threw before `sql` was assigned (e.g. assertTestDatabaseUrl
      // rejected the URL), skip cleanup so the original failure surfaces instead
      // of a masking "Cannot read properties of undefined" from `sql.unsafe`.
      if (!sql) return;
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    describe("getOrderDetail", () => {
      it("resolves override-else-catalog per price type on the override order", async () => {
        const detail = await getOrderDetail(order1Id, NOW);
        expect(detail).not.toBeNull();
        expect(detail!.status).toBe("COMPLETED");
        expect(detail!.item.offeringName).toBe("Enterprise SIP Trunk");
        expect(detail!.item.offeringVersion).toBe(2);
        expect(detail!.item.orderedCharacteristics).toEqual(CHARACTERISTICS);

        const byType = new Map(detail!.prices.map((p) => [p.priceType, p]));

        // recurring: overridden 420.00 over the 5000.00 list row.
        expect(byType.get("recurring")).toMatchObject({
          listAmount: "5000.00",
          overrideAmount: "420.00",
          effectiveAmount: "420.00",
        });
        // once: list price, no override.
        expect(byType.get("once")).toMatchObject({
          listAmount: "1000.00",
          overrideAmount: null,
          effectiveAmount: "1000.00",
        });
        // usage: tiered — no scalar list amount, never overridable.
        expect(byType.get("usage")).toMatchObject({
          listAmount: null,
          overrideAmount: null,
          effectiveAmount: null,
        });
      });

      it("selects only the currently-effective catalog row (future successor excluded)", async () => {
        const detail = await getOrderDetail(order1Id, NOW);
        const recurringLines = detail!.prices.filter(
          (p) => p.priceType === "recurring",
        );
        expect(recurringLines).toHaveLength(1);
        expect(recurringLines[0]!.listAmount).toBe("5000.00");
      });

      it("shows every overrideAmount null on the standard order", async () => {
        const detail = await getOrderDetail(order2Id, NOW);
        expect(detail!.prices.length).toBeGreaterThan(0);
        for (const line of detail!.prices) {
          expect(line.overrideAmount).toBeNull();
        }
        const recurring = detail!.prices.find(
          (p) => p.priceType === "recurring",
        );
        expect(recurring!.effectiveAmount).toBe("5000.00");
      });

      it("returns null for an unknown order id", async () => {
        expect(await getOrderDetail("PRDORD99999999", NOW)).toBeNull();
      });

      it("still reads through a RETIRED pinned version (grandfathering, Inv. #17)", async () => {
        await db
          .update(productOffering)
          .set({ lifecycleStatus: "RETIRED" })
          .where(eq(productOffering.productOfferingId, offeringId));

        try {
          const detail = await getOrderDetail(order1Id, NOW);
          expect(detail).not.toBeNull();
          const recurring = detail!.prices.find(
            (p) => p.priceType === "recurring",
          );
          expect(recurring).toMatchObject({
            listAmount: "5000.00",
            effectiveAmount: "420.00",
          });
        } finally {
          // Restore for later assertions even if one above fails, so the
          // shared fixture isn't left RETIRED for the next test.
          await db
            .update(productOffering)
            .set({ lifecycleStatus: "ACTIVE" })
            .where(eq(productOffering.productOfferingId, offeringId));
        }
      });
    });

    describe("listOrders", () => {
      it("returns exactly the seeded PENDING order when filtered by status", async () => {
        const page = await listOrders({
          q: "",
          status: "PENDING",
          sort: "-submitted_at",
          page: 1,
          order: null,
        });
        expect(page.total).toBe(1);
        expect(page.rows).toHaveLength(1);
        expect(page.rows[0]!.orderId).toBe(order3Id);
        expect(page.rows[0]!.hasOverride).toBe(true);
        expect(page.rows[0]!.customerName).toBe("Sample Telecom");
      });

      it("lists all four orders with resolved names and override flags", async () => {
        const page = await listOrders({
          q: "",
          status: null,
          sort: "-submitted_at",
          page: 1,
          order: null,
        });
        expect(page.total).toBe(4);
        const byId = new Map(page.rows.map((r) => [r.orderId, r]));
        expect(byId.get(order1Id)).toMatchObject({
          hasOverride: true,
          submittedByName: "Order Submitter",
          reviewedByName: "Order Reviewer",
          offeringVersion: 2,
        });
        expect(byId.get(order2Id)).toMatchObject({
          hasOverride: false,
          reviewedByName: null,
        });
        expect(byId.get(order4Id)).toMatchObject({
          status: "REJECTED",
          hasOverride: false,
        });
      });
    });

    describe("productOrderRepository.findList (filter/search/sort/pagination)", () => {
      it("paginates deterministically", async () => {
        const p1 = await productOrderRepository.findList(db, {
          q: "",
          status: null,
          sort: "product_order_id",
          page: 1,
          pageSize: 2,
        });
        expect(p1.total).toBe(4);
        expect(p1.rows).toHaveLength(2);
        const p2 = await productOrderRepository.findList(db, {
          q: "",
          status: null,
          sort: "product_order_id",
          page: 2,
          pageSize: 2,
        });
        expect(p2.rows).toHaveLength(2);
        const ids = [...p1.rows, ...p2.rows].map((r) => r.orderId);
        expect(new Set(ids).size).toBe(4);
        // ascending, contiguous across the page boundary
        expect(ids).toEqual([...ids].sort());
      });

      it("searches by customer name and by order id", async () => {
        const byName = await productOrderRepository.findList(db, {
          q: "Sample Telecom",
          status: null,
          sort: "-submitted_at",
          page: 1,
          pageSize: 20,
        });
        expect(byName.total).toBe(4);

        const byId = await productOrderRepository.findList(db, {
          q: order1Id,
          status: null,
          sort: "-submitted_at",
          page: 1,
          pageSize: 20,
        });
        expect(byId.total).toBe(1);
        expect(byId.rows[0]!.orderId).toBe(order1Id);
      });

      it("sorts by submitted_at descending by default order", async () => {
        const desc = await productOrderRepository.findList(db, {
          q: "",
          status: null,
          sort: "-submitted_at",
          page: 1,
          pageSize: 20,
        });
        const times = desc.rows.map((r) => r.submittedAt.getTime());
        expect(times).toEqual([...times].sort((a, b) => b - a));
      });
    });

    describe("inventory repositories (smoke)", () => {
      it("inserts a subscription + gap-free history and reads them back", async () => {
        const created = await productInventoryRepository.insertInventory(db, {
          productOrderItemId: item1Id,
          customerPartyRoleId: partyRoleId,
          billingAccountId: bannId,
          productOfferingId: offeringId,
          quantity: 1,
          instanceCharacteristics: CHARACTERISTICS,
          status: "ACTIVE",
          startDate: "2026-03-01",
        });
        await inventoryStatusHistoryRepository.insertTransition(db, {
          productInventoryId: created.productInventoryId,
          fromStatus: null,
          toStatus: "ACTIVE",
          effectiveDate: "2026-03-01",
          changedBy: submitterId,
        });
        await inventoryStatusHistoryRepository.insertTransition(db, {
          productInventoryId: created.productInventoryId,
          fromStatus: "ACTIVE",
          toStatus: "SUSPENDED",
          effectiveDate: "2026-05-01",
          changedBy: reviewerId,
        });

        const found = await productInventoryRepository.findById(
          db,
          created.productInventoryId,
        );
        expect(found?.status).toBe("ACTIVE");

        const history =
          await inventoryStatusHistoryRepository.findByInventoryId(
            db,
            created.productInventoryId,
          );
        expect(history.map((h) => h.toStatus)).toEqual(["ACTIVE", "SUSPENDED"]);
        expect(history[0]!.fromStatus).toBeNull();

        const list = await productInventoryRepository.findList(db, {
          q: "Sample Telecom",
          status: null,
          sort: "-start_date",
          page: 1,
          pageSize: 20,
        });
        expect(list.total).toBe(1);
        expect(list.rows[0]!.offeringName).toBe("Enterprise SIP Trunk");
      });
    });
  },
);
