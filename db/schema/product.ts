import {
  type AnyPgColumn,
  boolean,
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { appuser } from "@/db/schema/identity";
import type { ProductSpecCharacteristics } from "@/validation/product/product-spec-characteristics.schema";
import type { PricingComponent } from "@/validation/product/pricing-component.schema";

export const product = pgSchema("product");

// Declaration order IS lifecycle order (DRAFT → TESTING → ACTIVE → OBSOLETE →
// RETIRED). Postgres orders enum values by declaration, so this ordering is
// load-bearing for `ORDER BY lifecycle_status` and any `<`/`>` comparison — do
// not re-sort into alphabetical order (pm35-spec D3).
export const lifecycleStatus = product.enum("lifecycle_status", [
  "DRAFT",
  "TESTING",
  "ACTIVE",
  "OBSOLETE",
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
export const ratecardVersionSeq = product.sequence("ratecard_version_seq", {
  startWith: 1,
});

// The two expression unique indexes below are declared here AND in
// 0040_product_family_guards.sql (the SQL of record). That migration ALSO adds
// the `product.child_write_requires_draft()` trigger function and its two
// BEFORE INSERT OR UPDATE OR DELETE triggers on product_specifications /
// product_offering_price — a function and triggers have NO Drizzle
// representation, so 0040 is authoritative for them and this schema mirror
// carries only the indexes (pm36-spec D3/I2, following the "kept in sync with
// it" precedent in db/schema/billing/documents.ts).
export const productOffering = product.table(
  "product_offering",
  {
    productOfferingId: text("product_offering_id")
      .primaryKey()
      .default(
        sql`'PRDOFR' || lpad(nextval('product.product_offering_seq')::text, 8, '0')`,
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
    familyOfferingId: text("family_offering_id").references(
      (): AnyPgColumn => productOffering.productOfferingId,
      { onDelete: "restrict" },
    ),
  },
  (t) => [
    index("product_offering_family_idx").on(t.familyOfferingId),
    check(
      "product_offering_family_not_self_check",
      sql`family_offering_id IS NULL OR family_offering_id <> product_offering_id`,
    ),
    // pm36-spec D1/I2 — one ACTIVE and one open (DRAFT|TESTING) version per
    // family, expression-indexed on COALESCE(family_offering_id,
    // product_offering_id) so a family root (family_offering_id IS NULL)
    // indexes its own id and collides with its branches. Mirrors
    // 0040_product_family_guards.sql exactly; that migration is the SQL of
    // record. Backs the advisory lock in activateOffering, does not replace it.
    uniqueIndex("product_offering_one_active_per_family")
      .on(sql`(coalesce(${t.familyOfferingId}, ${t.productOfferingId}))`)
      .where(sql`${t.lifecycleStatus} = 'ACTIVE'`),
    uniqueIndex("product_offering_one_open_per_family")
      .on(sql`(coalesce(${t.familyOfferingId}, ${t.productOfferingId}))`)
      .where(sql`${t.lifecycleStatus} IN ('DRAFT','TESTING')`),
  ],
);

export const productSpecifications = product.table(
  "product_specifications",
  {
    productSpecId: text("product_spec_id")
      .primaryKey()
      .default(
        sql`'PRDSMD' || lpad(nextval('product.product_specifications_seq')::text, 8, '0')`,
      ),
    refProductOfferingId: text("ref_product_offering_id")
      .notNull()
      .references(() => productOffering.productOfferingId, {
        onDelete: "cascade",
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
        sql`'PRDOFP' || lpad(nextval('product.product_offering_price_seq')::text, 8, '0')`,
      ),
    productOfferingId: text("product_offering_id")
      .notNull()
      .references(() => productOffering.productOfferingId, {
        onDelete: "cascade",
      }),
    name: text("name").notNull(),
    componentType: text("component_type").notNull(),
    priceComponent: jsonb("price_component")
      .$type<PricingComponent>()
      .notNull(),
    recurringChargePeriodLength: integer("recurring_charge_period_length"),
    recurringChargePeriodType: text("recurring_charge_period_type"),
    unitOfMeasure: text("unit_of_measure"),
    currency: text("currency").notNull(),
    glCode: text("gl_code"),
    policy: text("policy"),
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
    // Rekeyed per pm46-spec D6/G-F. `NULLS NOT DISTINCT` because
    // `unit_of_measure` is NULL on every `flat_fee` row and a plain UNIQUE
    // treats two NULLs as distinct — without it, two `flat_fee` rows sharing a
    // `start_date_time` would both insert and VI4 would silently not hold
    // (precedent: 0013_gl_mapping_nulls_not_distinct.sql). A sentinel
    // `unit_of_measure` string + a `COALESCE` expression index were
    // considered and rejected (architecture §3.4/§7, corrected by this unit).
    // The `lead()` derived-end window in the repository (pm49) and both
    // runtime readers (pm51/pm52) MUST partition on this same
    // (product_offering_id, component_type, unit_of_measure) key, or a
    // `capacity_motivation` row could supersede the `usage_rate` beside it.
    unique("product_offering_price_component_start_unique")
      .on(
        t.productOfferingId,
        t.componentType,
        t.unitOfMeasure,
        t.startDateTime,
      )
      .nullsNotDistinct(),
    index("product_offering_price_offering_idx").on(t.productOfferingId),
    index("product_offering_price_component_type_idx").on(t.componentType),
    check(
      "product_offering_price_currency_check",
      sql`char_length(currency) = 3`,
    ),
    check(
      "product_offering_price_period_value_check",
      sql`recurring_charge_period_type IS NULL OR (recurring_charge_period_type = 'months' AND recurring_charge_period_length IN (1, 3, 12))`,
    ),
    check(
      "product_offering_price_unit_value_check",
      sql`unit_of_measure IS NULL OR unit_of_measure IN ('Mbps', 'GB', 'MB', 'EA')`,
    ),
    // Per-component-type completeness (pm46-spec D3 / I1.4). Mirrors
    // 0006_product.sql exactly — the database owns these predicates; Drizzle
    // is the mirror (code-standards §6.5). Six constraints so a violation
    // names its own cause; `product.pricing_steps_ok` is the schema-local
    // IMMUTABLE helper the last one calls (a CHECK cannot contain a subquery).
    check(
      "product_offering_price_component_type_check",
      sql`component_type IN ('usage_rate','flat_fee','capacity_commitment','capacity_motivation')`,
    ),
    check(
      "product_offering_price_envelope_type_check",
      sql`component_type = price_component ->> '@type'`,
    ),
    check(
      "product_offering_price_usage_rate_check",
      sql`component_type <> 'usage_rate' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL AND COALESCE(jsonb_typeof(price_component #> '{params,ratePerUnit}'), 'missing') = 'string' AND price_component #>> '{params,ratePerUnit}' ~ '^[0-9]+(\\.[0-9]+)?$')`,
    ),
    check(
      "product_offering_price_flat_fee_check",
      sql`component_type <> 'flat_fee' OR (unit_of_measure IS NULL AND COALESCE(jsonb_typeof(price_component #> '{params,amount}'), 'missing') = 'string' AND price_component #>> '{params,amount}' ~ '^[0-9]+(\\.[0-9]+)?$' AND COALESCE(price_component ->> 'priceType', '') IN ('recurring', 'oneTime') AND ((price_component ->> 'priceType' = 'recurring' AND recurring_charge_period_length IS NOT NULL AND recurring_charge_period_type IS NOT NULL) OR (price_component ->> 'priceType' = 'oneTime' AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL)))`,
    ),
    check(
      "product_offering_price_capacity_commitment_check",
      sql`component_type <> 'capacity_commitment' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL AND CASE WHEN jsonb_typeof(price_component #> '{params,committedQuantity}') = 'number' THEN (price_component #>> '{params,committedQuantity}')::numeric > 0 ELSE false END)`,
    ),
    check(
      "product_offering_price_capacity_motivation_check",
      sql`component_type <> 'capacity_motivation' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL AND product.pricing_steps_ok(price_component #> '{params,steps}'))`,
    ),
  ],
);

// pm57-spec D2/I1/I2 — physical DDL of record is
// db/migrations/0041_ratecard_ran_usage_lkp.sql; this is the hand-synced
// mirror (no drizzle-kit generate, code-standards §6.25). One row per
// upload. `snapshotDate` is the file's hoisted Date column — constant
// across the file, NEVER stored per row, NEVER used for matching, and the
// sole source of retired_at on the child table (RC17, Inv. #49).
// `status = 'REJECTED'` and `rejectSummary` have no writer in this delivery
// (code-standards §1.42) — a failed upload writes nothing, including no
// version row. Both exist for a future asynchronous ingest.
export const ratecardVersion = product.table(
  "ratecard_version",
  {
    ratecardVersionId: text("ratecard_version_id")
      .primaryKey()
      .default(
        sql`'RCV' || lpad(nextval('product.ratecard_version_seq')::text, 8, '0')`,
      ),
    cardName: text("card_name").notNull(),
    versionNum: integer("version_num").notNull(),
    status: text("status").notNull(),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    sourceFile: text("source_file").notNull(),
    fileChecksum: text("file_checksum"),
    rowCount: integer("row_count").notNull(),
    carriedRowCount: integer("carried_row_count").notNull().default(0),
    uploadedBy: text("uploaded_by").references(() => appuser.id, {
      onDelete: "set null",
    }),
    uploadedAt: timestamp("uploaded_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    activatedBy: text("activated_by").references(() => appuser.id, {
      onDelete: "set null",
    }),
    activatedAt: timestamp("activated_at", {
      withTimezone: true,
      mode: "date",
    }),
    supersededByVersionId: text("superseded_by_version_id"),
    rejectSummary: jsonb("reject_summary"),
  },
  (t) => [
    unique("ratecard_version_card_name_version_num_unique").on(
      t.cardName,
      t.versionNum,
    ),
    check(
      "ratecard_version_status_check",
      sql`status IN ('DRAFT','ACTIVE','SUPERSEDED','REJECTED')`,
    ),
    // At most one live version per card, enforced by the index, not by
    // application code (RV1, Inv. #45) — the direct analogue of
    // product_offering_one_active_per_family.
    uniqueIndex("ratecard_version_one_active_per_card")
      .on(t.cardName)
      .where(sql`${t.status} = 'ACTIVE'`),
    // C8, decided (pm57-spec D5, option A): at most one open DRAFT per card.
    // The accepted cost — an abandoned draft blocks the next upload until
    // activated, since Phase A has no discard and no `ratecard : DELETE` —
    // is recorded in the hand-off register, not hidden.
    uniqueIndex("ratecard_version_one_draft_per_card")
      .on(t.cardName)
      .where(sql`${t.status} = 'DRAFT'`),
  ],
);

// pm57-spec D3/I1/I2 — the rows of one version. ULID default
// (core.generate_ulid()), not a padded sequence: ~5,500 rows per upload has
// no use for a human-readable id, the id is never displayed, and a shared
// sequence would be the upload's bottleneck (code-standards §6.24). One FK
// only. `lkpSubscriberRefId` carries a product_inventory.product_inventory_id
// VALUE, not a reference — no FK (RC14, Inv. #57), same no-FK stance as
// rating.udr_rated (Inv. #17): a superseded version must survive a
// subscription's removal. `serviceCode` and `ratePerUnit` are plain columns
// with no CHECK and no meaning — stored as uploaded, nothing consumes them
// (D3/D4, code-standards §1.45/§3.2). No capacity column, no currency
// column (RC4, Inv. #53).
export const ratecardRanUsageLkp = product.table(
  "ratecard_ran_usage_lkp",
  {
    ratecardRanUsageLkpId: uuid("ratecard_ran_usage_lkp_id")
      .primaryKey()
      .default(sql`core.generate_ulid()`),
    ratecardVersionId: text("ratecard_version_id")
      .notNull()
      .references(() => ratecardVersion.ratecardVersionId, {
        onDelete: "cascade",
      }),
    mnoPublicKey: text("mno_public_key").notNull(),
    commercialUnitPublicKey: text("commercial_unit_public_key").notNull(),
    polygonId: text("polygon_id").notNull(),
    polygonStartDate: date("polygon_start_date", { mode: "string" }).notNull(),
    lkpSubscriberRefId: text("lkp_subscriber_ref_id").notNull(),
    serviceCode: text("service_code"),
    ratePerUnit: numeric("rate_per_unit", {
      mode: "string",
      precision: 18,
      scale: 6,
    }),
    retiredAt: date("retired_at", { mode: "string" }),
  },
  (t) => [
    unique("ratecard_ran_usage_lkp_row_key_unique").on(
      t.ratecardVersionId,
      t.mnoPublicKey,
      t.commercialUnitPublicKey,
      t.polygonId,
      t.polygonStartDate,
    ),
    // The rating consumer's as-of join key (code-standards §6.28) — created
    // now though nothing consumes it in this delivery (§6.31).
    index("ratecard_ran_usage_lkp_as_of_idx").on(
      t.ratecardVersionId,
      t.mnoPublicKey,
      t.commercialUnitPublicKey,
      t.polygonId,
      sql`${t.polygonStartDate} DESC`,
    ),
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
export type RatecardVersion = typeof ratecardVersion.$inferSelect;
export type RatecardVersionInsert = typeof ratecardVersion.$inferInsert;
export type RatecardRanUsageLkp = typeof ratecardRanUsageLkp.$inferSelect;
export type RatecardRanUsageLkpInsert = typeof ratecardRanUsageLkp.$inferInsert;
