import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { appuser } from "@/db/schema/identity";
import { partyRole } from "@/db/schema/customer";
import { billingAccount } from "@/db/schema/billing/accounts";
import { productOffering } from "@/db/schema/product";
import { ORDER_STATUSES } from "@/types/ordering";

// TMF622 — write-once order intake. All billing dates in this schema are
// **inclusive-billed** (architecture Inv. #21, `_updatemodule…-plan.md` #21):
// `start_date` is the first billed day. Effectivity dates are the `date` type
// (not `timestamptz`) — a billed day is a calendar day, never an instant.
export const ordering = pgSchema("ordering");

export const orderStatus = ordering.enum("order_status", ORDER_STATUSES);

export const productOrderSeq = ordering.sequence("product_order_seq", {
  startWith: 1,
});
export const productOrderItemSeq = ordering.sequence("product_order_item_seq", {
  startWith: 1,
});
export const orderItemPriceOverrideSeq = ordering.sequence(
  "order_item_price_override_seq",
  { startWith: 1 },
);

export const productOrder = ordering.table(
  "product_order",
  {
    productOrderId: text("product_order_id")
      .primaryKey()
      .default(
        sql`'PRDORD' || lpad(nextval('ordering.product_order_seq')::text, 8, '0')`,
      ),
    customerPartyRoleId: text("customer_party_role_id")
      .notNull()
      .references(() => partyRole.partyRoleId, { onDelete: "restrict" }),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccount.billingAccountId, {
        onDelete: "restrict",
      }),
    status: orderStatus("status").notNull(),
    failureReason: text("failure_reason"),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => appuser.id, { onDelete: "restrict" }),
    submittedAt: timestamp("submitted_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    // Set on approve **or** reject (Q18); the CHECK backstops reviewer ≠
    // submitter (architecture Inv. #22).
    reviewedBy: text("reviewed_by").references(() => appuser.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamp("reviewed_at", {
      withTimezone: true,
      mode: "date",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
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
    index("product_order_customer_idx").on(t.customerPartyRoleId),
    index("product_order_billing_account_idx").on(t.billingAccountId),
    index("product_order_status_idx").on(t.status),
    // Supports the orders-list default sort (submitted_at desc, orders-list
    // schema) — a listing scan resolves from the index rather than sorting.
    index("product_order_submitted_at_idx").on(t.submittedAt.desc()),
    check(
      "product_order_reviewer_check",
      sql`reviewed_by IS NULL OR reviewed_by <> submitted_by`,
    ),
  ],
);

export const productOrderItem = ordering.table(
  "product_order_item",
  {
    productOrderItemId: text("product_order_item_id")
      .primaryKey()
      .default(
        sql`'PRDORI' || lpad(nextval('ordering.product_order_item_seq')::text, 8, '0')`,
      ),
    productOrderId: text("product_order_id")
      .notNull()
      .references(() => productOrder.productOrderId, { onDelete: "restrict" }),
    // Pinned to the exact `product_offering` version ordered (Q5
    // grandfathering) — the immutable version FK *is* the price/spec snapshot.
    productOfferingId: text("product_offering_id")
      .notNull()
      .references(() => productOffering.productOfferingId, {
        onDelete: "restrict",
      }),
    quantity: integer("quantity").notNull(),
    startDate: date("start_date").notNull(),
    orderedCharacteristics: jsonb("ordered_characteristics").$type<
      Record<string, string>
    >(),
    // Write-once (architecture Inv. #15) — no `updated_at`.
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("product_order_item_order_idx").on(t.productOrderId),
    index("product_order_item_offering_idx").on(t.productOfferingId),
    check("product_order_item_quantity_check", sql`quantity >= 1`),
  ],
);

export const orderItemPriceOverride = ordering.table(
  "order_item_price_override",
  {
    orderItemPriceOverrideId: text("order_item_price_override_id")
      .primaryKey()
      .default(
        sql`'PRDOPO' || lpad(nextval('ordering.order_item_price_override_seq')::text, 8, '0')`,
      ),
    productOrderItemId: text("product_order_item_id")
      .notNull()
      .references(() => productOrderItem.productOrderItemId, {
        onDelete: "restrict",
      }),
    priceType: text("price_type").notNull(),
    amount: numeric("amount", {
      mode: "string",
      precision: 12,
      scale: 2,
    }).notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Insert-only, at most one override per (item, price_type) (architecture
    // §3, Inv. #16). This repository never gains update/delete (Inv. #16).
    unique("order_item_price_override_item_type_unique").on(
      t.productOrderItemId,
      t.priceType,
    ),
    index("order_item_price_override_item_idx").on(t.productOrderItemId),
    check("order_item_price_override_amount_check", sql`amount > 0`),
    // Normalize price_type/currency so the (item, price_type) unique constraint
    // can't be defeated by casing/spelling variants (catalog
    // product_offering_price precedent): only flat catalog price types, and a
    // 3-char currency code.
    check(
      "order_item_price_override_price_type_check",
      sql`price_type IN ('recurring','usage','once')`,
    ),
    check(
      "order_item_price_override_currency_check",
      sql`char_length(currency) = 3`,
    ),
  ],
);

export type ProductOrder = typeof productOrder.$inferSelect;
export type ProductOrderInsert = typeof productOrder.$inferInsert;
export type ProductOrderItem = typeof productOrderItem.$inferSelect;
export type ProductOrderItemInsert = typeof productOrderItem.$inferInsert;
export type OrderItemPriceOverride = typeof orderItemPriceOverride.$inferSelect;
export type OrderItemPriceOverrideInsert =
  typeof orderItemPriceOverride.$inferInsert;
