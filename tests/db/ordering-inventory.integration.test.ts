import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { productOffering } from "@/db/schema/product";
import {
  productOrder,
  productOrderItem,
  orderItemPriceOverride,
} from "@/db/schema/ordering";
import {
  productInventory,
  inventoryStatusHistory,
} from "@/db/schema/inventory";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "ordering + inventory schema constraints (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;

    // Shared valid fixtures — each constraint test builds a bad row against
    // these known-good FK targets so the failure is provably the CHECK/UNIQUE,
    // not a dangling FK.
    let submitterId: string;
    let reviewerId: string;
    let partyRoleId: string;
    let bannId: string;
    let offeringId: string;

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

    // Inserts a valid order + item and returns the item id — the anchor for
    // override and inventory constraint tests.
    async function newOrderItem(): Promise<string> {
      const [order] = await db
        .insert(productOrder)
        .values({
          customerPartyRoleId: partyRoleId,
          billingAccountId: bannId,
          status: "COMPLETED",
          submittedBy: submitterId,
        })
        .returning({ productOrderId: productOrder.productOrderId });
      const [item] = await db
        .insert(productOrderItem)
        .values({
          productOrderId: order!.productOrderId,
          productOfferingId: offeringId,
          quantity: 1,
          startDate: "2026-03-01",
          orderedCharacteristics: { SST_ID: "01" },
        })
        .returning({ productOrderItemId: productOrderItem.productOrderItemId });
      return item!.productOrderItemId;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      // Drop dependents before their targets (CASCADE makes order moot, but
      // keep it readable): inventory → ordering → billing → customer →
      // product → core, then the migrator's bookkeeping.
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

      submitterId = await newAppUser("Order Submitter");
      reviewerId = await newAppUser("Order Reviewer");

      const [org] = await db
        .insert(organization)
        .values({
          name: "Ordering Test Org",
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
        .values({ name: "Ordering Test Cycle", lastEditedBy: submitterId })
        .returning({ billCycleId: billCycle.billCycleId });
      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: "Ordering Test FA",
          refPartyRoleId: partyRoleId,
          currency: "MYR",
          lastEditedBy: submitterId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "Ordering Test BAN",
          refPartyRoleId: partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: "MYR",
          refBillCycleId: cycle!.billCycleId,
          lastEditedBy: submitterId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      bannId = ban!.billingAccountId;

      const [offering] = await db
        .insert(productOffering)
        .values({
          name: "Ordering Test Offering",
          isBundle: false,
          isSellable: true,
          billingOnly: false,
          lifecycleStatus: "ACTIVE",
          version: 1,
          lastEditedBy: null,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      offeringId = offering!.productOfferingId;
    }, 30_000);

    afterAll(async () => {
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

    it("accepts a fully valid order → item → override → inventory → history chain", async () => {
      const itemId = await newOrderItem();
      await expect(
        db.insert(orderItemPriceOverride).values({
          productOrderItemId: itemId,
          priceType: "recurring",
          amount: "420.00",
          currency: "MYR",
        }),
      ).resolves.toBeDefined();
      const [inv] = await db
        .insert(productInventory)
        .values({
          productOrderItemId: itemId,
          customerPartyRoleId: partyRoleId,
          billingAccountId: bannId,
          productOfferingId: offeringId,
          quantity: 1,
          status: "ACTIVE",
          startDate: "2026-03-01",
          instanceCharacteristics: { SST_ID: "01" },
        })
        .returning({ productInventoryId: productInventory.productInventoryId });
      await expect(
        db.insert(inventoryStatusHistory).values({
          productInventoryId: inv!.productInventoryId,
          fromStatus: null,
          toStatus: "ACTIVE",
          effectiveDate: "2026-03-01",
          changedBy: submitterId,
        }),
      ).resolves.toBeDefined();
    });

    it("rejects quantity 0 on an order item (product_order_item_quantity_check)", async () => {
      const [order] = await db
        .insert(productOrder)
        .values({
          customerPartyRoleId: partyRoleId,
          billingAccountId: bannId,
          status: "PENDING",
          submittedBy: submitterId,
        })
        .returning({ productOrderId: productOrder.productOrderId });
      await expect(
        db.insert(productOrderItem).values({
          productOrderId: order!.productOrderId,
          productOfferingId: offeringId,
          quantity: 0,
          startDate: "2026-03-01",
        }),
      ).rejects.toThrow();
    });

    it("rejects a duplicate (item, price_type) override (unique constraint)", async () => {
      const itemId = await newOrderItem();
      await db.insert(orderItemPriceOverride).values({
        productOrderItemId: itemId,
        priceType: "recurring",
        amount: "100.00",
        currency: "MYR",
      });
      await expect(
        db.insert(orderItemPriceOverride).values({
          productOrderItemId: itemId,
          priceType: "recurring",
          amount: "200.00",
          currency: "MYR",
        }),
      ).rejects.toThrow();
    });

    it("rejects an override amount <= 0 (order_item_price_override_amount_check)", async () => {
      const itemId = await newOrderItem();
      await expect(
        db.insert(orderItemPriceOverride).values({
          productOrderItemId: itemId,
          priceType: "once",
          amount: "0.00",
          currency: "MYR",
        }),
      ).rejects.toThrow();
    });

    it("rejects reviewed_by = submitted_by (product_order_reviewer_check)", async () => {
      await expect(
        db.insert(productOrder).values({
          customerPartyRoleId: partyRoleId,
          billingAccountId: bannId,
          status: "REJECTED",
          submittedBy: submitterId,
          reviewedBy: submitterId,
          reviewedAt: new Date(),
        }),
      ).rejects.toThrow();
    });

    it("accepts reviewed_by <> submitted_by", async () => {
      await expect(
        db.insert(productOrder).values({
          customerPartyRoleId: partyRoleId,
          billingAccountId: bannId,
          status: "REJECTED",
          submittedBy: submitterId,
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
        }),
      ).resolves.toBeDefined();
    });

    it("rejects end_date < start_date on inventory (product_inventory_end_after_start_check)", async () => {
      const itemId = await newOrderItem();
      await expect(
        db.insert(productInventory).values({
          productOrderItemId: itemId,
          customerPartyRoleId: partyRoleId,
          billingAccountId: bannId,
          productOfferingId: offeringId,
          quantity: 1,
          status: "TERMINATED",
          startDate: "2026-03-01",
          endDate: "2026-02-01",
        }),
      ).rejects.toThrow();
    });

    it("rejects a second inventory for the same order item (unique FK, 1:1)", async () => {
      const itemId = await newOrderItem();
      await db.insert(productInventory).values({
        productOrderItemId: itemId,
        customerPartyRoleId: partyRoleId,
        billingAccountId: bannId,
        productOfferingId: offeringId,
        quantity: 1,
        status: "ACTIVE",
        startDate: "2026-03-01",
      });
      await expect(
        db.insert(productInventory).values({
          productOrderItemId: itemId,
          customerPartyRoleId: partyRoleId,
          billingAccountId: bannId,
          productOfferingId: offeringId,
          quantity: 1,
          status: "ACTIVE",
          startDate: "2026-04-01",
        }),
      ).rejects.toThrow();
    });

    it("rejects an order referencing an absent party role (FK violation)", async () => {
      await expect(
        db.insert(productOrder).values({
          customerPartyRoleId: "PTRL99999999",
          billingAccountId: bannId,
          status: "PENDING",
          submittedBy: submitterId,
        }),
      ).rejects.toThrow();
    });

    it("rejects inventory referencing an absent order item (FK violation)", async () => {
      await expect(
        db.insert(productInventory).values({
          productOrderItemId: "PRDORI99999999",
          customerPartyRoleId: partyRoleId,
          billingAccountId: bannId,
          productOfferingId: offeringId,
          quantity: 1,
          status: "ACTIVE",
          startDate: "2026-03-01",
        }),
      ).rejects.toThrow();
    });

    it("rejects an override with an invalid price_type (check constraint)", async () => {
      const itemId = await newOrderItem();
      await expect(
        db.insert(orderItemPriceOverride).values({
          productOrderItemId: itemId,
          priceType: "RECURRING", // wrong casing — must be a flat catalog type
          amount: "10.00",
          currency: "MYR",
        }),
      ).rejects.toThrow();
    });

    it("rejects an override with a non-3-char currency (check constraint)", async () => {
      const itemId = await newOrderItem();
      await expect(
        db.insert(orderItemPriceOverride).values({
          productOrderItemId: itemId,
          priceType: "recurring",
          amount: "10.00",
          currency: "MYRR",
        }),
      ).rejects.toThrow();
    });

    it("rejects a second creation history row (from_status NULL) for one instance", async () => {
      const itemId = await newOrderItem();
      const [inv] = await db
        .insert(productInventory)
        .values({
          productOrderItemId: itemId,
          customerPartyRoleId: partyRoleId,
          billingAccountId: bannId,
          productOfferingId: offeringId,
          quantity: 1,
          status: "ACTIVE",
          startDate: "2026-03-01",
        })
        .returning({ productInventoryId: productInventory.productInventoryId });
      await db.insert(inventoryStatusHistory).values({
        productInventoryId: inv!.productInventoryId,
        fromStatus: null,
        toStatus: "ACTIVE",
        effectiveDate: "2026-03-01",
        changedBy: submitterId,
      });
      // Partial unique index: at most one from_status IS NULL row per instance.
      await expect(
        db.insert(inventoryStatusHistory).values({
          productInventoryId: inv!.productInventoryId,
          fromStatus: null,
          toStatus: "SUSPENDED",
          effectiveDate: "2026-04-01",
          changedBy: submitterId,
        }),
      ).rejects.toThrow();
    });
  },
);
