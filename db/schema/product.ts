import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { appuser } from "@/db/schema/identity";
import type { ProductSpecCharacteristics } from "@/validation/product/product-spec-characteristics.schema";
import type { TieredPricingCharacteristics } from "@/validation/product/pricing-characteristics.schema";

export const product = pgSchema("product");

export const lifecycleStatus = product.enum("lifecycle_status", [
  "DRAFT",
  "ACTIVE",
  "RETIRED",
]);

export const productOfferingSeq = product.sequence("product_offering_seq", {
  startWith: 1,
});
export const productSpecificationsSeq = product.sequence(
  "product_specifications_seq",
  { startWith: 1 },
);
export const productOfferingPriceSeq = product.sequence(
  "product_offering_price_seq",
  { startWith: 1 },
);

export const productOffering = product.table("product_offering", {
  productOfferingId: text("product_offering_id")
    .primaryKey()
    .default(
      sql`'PRDOFR' || lpad(nextval('product.product_offering_seq')::text, 6, '0')`,
    ),
  name: text("name").notNull(),
  isBundle: boolean("is_bundle").notNull(),
  isSellable: boolean("is_sellable").notNull(),
  billingOnly: boolean("billing_only").notNull(),
  lifecycleStatus: lifecycleStatus("lifecycle_status")
    .notNull()
    .default("DRAFT"),
  version: integer("version").notNull().default(1),
  lastModified: timestamp("last_modified", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .default(sql`now()`),
  lastEditedBy: text("last_edited_by").references(() => appuser.id, {
    onDelete: "set null",
  }),
});

export const productSpecifications = product.table(
  "product_specifications",
  {
    productSpecId: text("product_spec_id")
      .primaryKey()
      .default(
        sql`'PRDSMD' || lpad(nextval('product.product_specifications_seq')::text, 6, '0')`,
      ),
    refProductOfferingId: text("ref_product_offering_id")
      .notNull()
      .references(() => productOffering.productOfferingId, {
        onDelete: "restrict",
      }),
    name: text("name").notNull(),
    isMandatory: boolean("is_mandatory").notNull(),
    isDefault: boolean("is_default").notNull(),
    defaultValue: text("default_value"),
    productSpecCharacteristics: jsonb("product_spec_characteristics")
      .notNull()
      .$type<ProductSpecCharacteristics>(),
  },
  (t) => [
    index("product_specifications_offering_idx").on(t.refProductOfferingId),
  ],
);

export const productOfferingPrice = product.table(
  "product_offering_price",
  {
    productOfferingPriceId: text("product_offering_price_id")
      .primaryKey()
      .default(
        sql`'PRDOFP' || lpad(nextval('product.product_offering_price_seq')::text, 6, '0')`,
      ),
    productOfferingId: text("product_offering_id")
      .notNull()
      .references(() => productOffering.productOfferingId, {
        onDelete: "restrict",
      }),
    name: text("name").notNull(),
    priceType: text("price_type").notNull(),
    recurringChargePeriodLength: integer("recurring_charge_period_length"),
    recurringChargePeriodType: text("recurring_charge_period_type"),
    unitOfMeasure: text("unit_of_measure"),
    amount: numeric("amount", { mode: "string" }),
    currency: text("currency").notNull(),
    glCode: text("gl_code"),
    pricingModel: text("pricing_model").notNull(),
    policy: text("policy"),
    pricingCharacteristics: jsonb(
      "pricing_characteristics",
    ).$type<TieredPricingCharacteristics>(),
    startDateTime: timestamp("start_date_time", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("product_offering_price_type_start_unique").on(
      t.productOfferingId,
      t.priceType,
      t.startDateTime,
    ),
    index("product_offering_price_offering_idx").on(t.productOfferingId),
    check(
      "product_offering_price_type_check",
      sql`price_type IN ('recurring','usage','once')`,
    ),
    check(
      "product_offering_price_pricing_model_check",
      sql`pricing_model IN ('flat','tiered')`,
    ),
    check(
      "product_offering_price_currency_check",
      sql`char_length(currency) = 3`,
    ),
    check(
      "product_offering_price_amount_xor_tiers_check",
      sql`(pricing_model = 'flat' AND amount IS NOT NULL AND pricing_characteristics IS NULL) OR (pricing_model = 'tiered' AND amount IS NULL AND pricing_characteristics IS NOT NULL)`,
    ),
    check("product_offering_price_amount_check", sql`amount >= 0`),
  ],
);

export type ProductOffering = typeof productOffering.$inferSelect;
export type ProductOfferingInsert = typeof productOffering.$inferInsert;
export type ProductSpecification = typeof productSpecifications.$inferSelect;
export type ProductSpecificationInsert =
  typeof productSpecifications.$inferInsert;
export type ProductOfferingPrice = typeof productOfferingPrice.$inferSelect;
export type ProductOfferingPriceInsert =
  typeof productOfferingPrice.$inferInsert;
