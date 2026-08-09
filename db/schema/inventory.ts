import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { appuser } from "@/db/schema/identity";
import { partyRole } from "@/db/schema/customer";
import { billingAccount } from "@/db/schema/billing/accounts";
import { productOffering } from "@/db/schema/product";
import { productOrderItem } from "@/db/schema/ordering";
import { PRODUCT_STATUSES } from "@/types/inventory";

// TMF637 — long-lived subscriptions (product inventory), the future bill-run
// read path. All dates are **inclusive-billed** (architecture Inv. #21):
// `start_date` = first billed day, `end_date` = last billed day. `date` type,
// not `timestamptz`.
export const inventory = pgSchema("inventory");

export const productStatus = inventory.enum("product_status", PRODUCT_STATUSES);

export const productInventorySeq = inventory.sequence("product_inventory_seq", {
  startWith: 1,
});
export const inventoryStatusHistorySeq = inventory.sequence(
  "inventory_status_history_seq",
  { startWith: 1 },
);

export const productInventory = inventory.table(
  "product_inventory",
  {
    productInventoryId: text("product_inventory_id")
      .primaryKey()
      .default(
        sql`'PRDINV' || lpad(nextval('inventory.product_inventory_seq')::text, 8, '0')`,
      ),
    // 1:1 with the order item (UNIQUE FK) — a single order item instantiates at
    // most one subscription (architecture §3).
    productOrderItemId: text("product_order_item_id")
      .notNull()
      .unique()
      .references(() => productOrderItem.productOrderItemId, {
        onDelete: "restrict",
      }),
    // Denormalized for the bill-run read path (architecture §3): the party,
    // BAN, and pinned offering version are carried here so a bill run resolves
    // them without re-walking the order graph.
    customerPartyRoleId: text("customer_party_role_id")
      .notNull()
      .references(() => partyRole.partyRoleId, { onDelete: "restrict" }),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccount.billingAccountId, {
        onDelete: "restrict",
      }),
    productOfferingId: text("product_offering_id")
      .notNull()
      .references(() => productOffering.productOfferingId, {
        onDelete: "restrict",
      }),
    quantity: integer("quantity").notNull(),
    // The only editable billing-adjacent field (Inv. #15); audited, never a
    // rating input.
    instanceCharacteristics: jsonb("instance_characteristics").$type<
      Record<string, string>
    >(),
    status: productStatus("status").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("product_inventory_customer_idx").on(t.customerPartyRoleId),
    index("product_inventory_billing_account_idx").on(t.billingAccountId),
    index("product_inventory_offering_idx").on(t.productOfferingId),
    index("product_inventory_status_idx").on(t.status),
    check("product_inventory_quantity_check", sql`quantity >= 1`),
    check(
      "product_inventory_end_after_start_check",
      sql`end_date IS NULL OR end_date >= start_date`,
    ),
  ],
);

// Append-only, gap-free transition log (architecture Inv. #18). The repository
// permanently exports no update/delete; there is no `updated_at` by shape.
export const inventoryStatusHistory = inventory.table(
  "inventory_status_history",
  {
    inventoryStatusHistoryId: text("inventory_status_history_id")
      .primaryKey()
      .default(
        sql`'PRDIVE' || lpad(nextval('inventory.inventory_status_history_seq')::text, 8, '0')`,
      ),
    productInventoryId: text("product_inventory_id")
      .notNull()
      .references(() => productInventory.productInventoryId, {
        onDelete: "restrict",
      }),
    // NULL only on the creation row (the instance's first status).
    fromStatus: productStatus("from_status"),
    toStatus: productStatus("to_status").notNull(),
    effectiveDate: date("effective_date").notNull(),
    reason: text("reason"),
    changedBy: text("changed_by")
      .notNull()
      .references(() => appuser.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("inventory_status_history_inventory_idx").on(t.productInventoryId),
  ],
);

export type ProductInventory = typeof productInventory.$inferSelect;
export type ProductInventoryInsert = typeof productInventory.$inferInsert;
export type InventoryStatusHistory = typeof inventoryStatusHistory.$inferSelect;
export type InventoryStatusHistoryInsert =
  typeof inventoryStatusHistory.$inferInsert;
