import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

import { appuser } from "@/db/schema/identity";
import type { RejectSummary } from "@/validation/product/ratecard.schema";
import type {
  AppliesAt,
  Basis,
  ComponentType,
  EnvelopePriceType,
  RateCardVersionStatus,
} from "@/types/product";

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
    familyOfferingId: text("family_offering_id"),
  },
  (t) => [
    // Explicit FK name — Drizzle's derived name exceeds Postgres's 63-byte
    // identifier cap (code-standards §"Constraint & index naming"). Self-ref:
    // a branch offering points at its family root.
    foreignKey({
      columns: [t.familyOfferingId],
      foreignColumns: [t.productOfferingId],
      name: "product_offering_family_offering_id_fk",
    }).onDelete("restrict"),
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
    refProductOfferingId: text("ref_product_offering_id").notNull(),
    name: text("name").notNull(),
    isMandatory: boolean("is_mandatory").notNull(),
    isDefault: boolean("is_default").notNull(),
    defaultValue: text("default_value"),
    // pm70 (0056): the `product_spec_characteristics` jsonb column is gone —
    // characteristics are rows in `product_spec_characteristic` (below).
  },
  (t) => [
    // Explicit FK name — Drizzle's derived name exceeds Postgres's 63-byte
    // identifier cap (code-standards §"Constraint & index naming").
    foreignKey({
      columns: [t.refProductOfferingId],
      foreignColumns: [productOffering.productOfferingId],
      name: "product_specifications_ref_product_offering_id_fk",
    }).onDelete("cascade"),
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
    productOfferingId: text("product_offering_id").notNull(),
    name: text("name").notNull(),
    componentType: text("component_type").notNull(),
    // pm70 (0056, G-N2 — Inv. #38 reversed 2026-11-19): the envelope's TMF
    // `priceType` as a column, constrained by the composite FK
    // `product_offering_price_price_type_fk` to the five seeded pairs in
    // `price_component_price_type`. Never equated with the legacy
    // `ordering.order_item_price_override.price_type` axis (§1.58). Replaces
    // the dropped `price_component` jsonb, whose variable half now lives in
    // the four `pop_*` subtype tables below.
    priceType: text("price_type").notNull().$type<EnvelopePriceType>(),
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
    // The price lane key (Inv. #2), plain columns since pm70 (0056):
    // (product_offering_id, component_type, unit_of_measure, price_type,
    // start_date_time), NULLS NOT DISTINCT. Equivalent to the pm46a key it
    // replaces — 0049_product_price_lane_key.sql's expression index on
    // `CASE WHEN component_type = 'flat_fee' THEN price_component ->> 'priceType'
    // END`: price_type is a constant per type for every non-flat_fee type (so it
    // adds nothing to their key, exactly as the CASE evaluated to NULL), and for
    // flat_fee it equals the envelope's priceType by 0056's backfill, so a
    // recurring and a one-time flat fee (both NULL unit) stay separate lanes.
    // History kept from 0049: NULLS NOT DISTINCT is load-bearing — without it two
    // identical recurring flat fees (NULL unit) at one start would both insert
    // (precedent: 0013_gl_mapping_nulls_not_distinct.sql); a sentinel
    // `unit_of_measure` string and a `COALESCE` expression index stay rejected
    // (G-F). C14 decision (pm70 D7, code-standards §6.34): it STAYS a unique
    // INDEX under the SAME NAME — services/product/insert-price.ts maps a 23505
    // on this name to DUPLICATE_START, and keeping the object kind keeps the
    // error's `constraint` field identical; a `unique().nullsNotDistinct()`
    // constraint was rejected for changing the kind under that name.
    // drizzle-orm 0.45 has no `nullsNotDistinct()` on `uniqueIndex()`, so the
    // clause lives in 0056's SQL only; guardrail 13 asserts it in pg_indexes.
    // The `lead()` derived-end window in the repository and the bill-run
    // recurring resolver MUST partition on this same key.
    // Explicit FK name — Drizzle's derived name exceeds Postgres's 63-byte
    // identifier cap (code-standards §"Constraint & index naming").
    foreignKey({
      columns: [t.productOfferingId],
      foreignColumns: [productOffering.productOfferingId],
      name: "product_offering_price_product_offering_id_fk",
    }).onDelete("cascade"),
    uniqueIndex("product_offering_price_lane_start_unique").on(
      t.productOfferingId,
      t.componentType,
      t.unitOfMeasure,
      t.priceType,
      t.startDateTime,
    ),
    // pm70 (§6.33/§6.36): the target of every subtype table's composite FK —
    // what pins a pop_* row to a header of its own type (Inv. #62).
    unique("product_offering_price_id_type_unique").on(
      t.productOfferingPriceId,
      t.componentType,
    ),
    // pm70: only seeded (component_type, price_type) pairs exist — replaces
    // the dropped component_type_check and envelope_type_check (§6.41).
    foreignKey({
      columns: [t.componentType, t.priceType],
      foreignColumns: [
        priceComponentPriceType.componentType,
        priceComponentPriceType.priceType,
      ],
      name: "product_offering_price_price_type_fk",
    }),
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
    // Per-type unit/period shape (pm70 D8). Same names as pm46's CHECKs (the
    // schema-diff guardrail keys on names), JSON-free since 0056 and keyed on
    // price_type for flat_fee. Completeness of the price parameters is no
    // longer a CHECK: it is the deferred `*_complete_ct` constraint triggers
    // (0056, §6.37 — a function and triggers have no Drizzle representation).
    check(
      "product_offering_price_usage_rate_check",
      sql`component_type <> 'usage_rate' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL)`,
    ),
    check(
      "product_offering_price_flat_fee_check",
      sql`component_type <> 'flat_fee' OR (unit_of_measure IS NULL AND ((price_type = 'recurring' AND recurring_charge_period_length IS NOT NULL AND recurring_charge_period_type IS NOT NULL) OR (price_type = 'oneTime' AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL)))`,
    ),
    check(
      "product_offering_price_capacity_commitment_check",
      sql`component_type <> 'capacity_commitment' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL)`,
    ),
    check(
      "product_offering_price_capacity_motivation_check",
      sql`component_type <> 'capacity_motivation' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// pm70 (Part 6 — Normalize). Physical DDL of record:
// db/migrations/0056_product_normalize_spec_price.sql; the declarations below
// are the hand-synced mirror (no drizzle-kit generate, no snapshot — README).
// Every constraint is named by hand, identical in SQL, here and in guardrail 13
// (code-standards §6.39): Drizzle's derived name for the subtype FKs is 67
// bytes and would be truncated by Postgres. Not mirrored here because Drizzle
// cannot represent them: the deferred completeness function + five
// `*_complete_ct` constraint triggers, the five `*_draft_guard` triggers, and
// the owner-privileged view `product.offering_price_v` — a SQL-only contract
// for billrun_runtime / rating_runtime, never declared in Drizzle and never
// read by the application (§1.62, §7.16).
// ---------------------------------------------------------------------------

// Reference table — system data seeded by migration, exactly four rows; not
// user-editable (app_runtime holds SELECT only, Inv. #64). `plaSpecId` is NULL
// for flat_fee and usage_rate (usage_rate's is derived from
// rate_card_lookup IS NOT NULL, Inv. #65). `applyOrder` is PC12 made explicit
// (Inv. #37).
export const priceComponentType = product.table(
  "price_component_type",
  {
    componentType: text("component_type").notNull().$type<ComponentType>(),
    appliesAt: text("applies_at").notNull().$type<AppliesAt>(),
    basis: text("basis").notNull().$type<Basis>(),
    plaSpecId: text("pla_spec_id"),
    applyOrder: integer("apply_order").notNull(),
  },
  (t) => [
    primaryKey({ name: "price_component_type_pk", columns: [t.componentType] }),
    check(
      "price_component_type_applies_at_check",
      sql`applies_at IN ('rating', 'billing', 'post_aggregation')`,
    ),
    check(
      "price_component_type_basis_check",
      sql`basis IN ('quantity', 'flat')`,
    ),
  ],
);

// Reference table — the five allowed (component_type, price_type) pairs, the
// target of the header's `product_offering_price_price_type_fk`.
export const priceComponentPriceType = product.table(
  "price_component_price_type",
  {
    componentType: text("component_type").notNull().$type<ComponentType>(),
    priceType: text("price_type").notNull().$type<EnvelopePriceType>(),
  },
  (t) => [
    primaryKey({
      name: "price_component_price_type_pk",
      columns: [t.componentType, t.priceType],
    }),
    foreignKey({
      columns: [t.componentType],
      foreignColumns: [priceComponentType.componentType],
      name: "price_component_price_type_type_fk",
    }),
  ],
);

// The four subtype tables carry the type-pinning pattern (§6.36, Inv. #62): a
// `component_type` column pinned by DEFAULT + CHECK to the table's own type, and
// a composite FK to the header's (id, component_type) unique, ON DELETE
// CASCADE. A subtype row for a header of another type is unrepresentable, and a
// header's component_type cannot change while one references it (Inv. #70).
// Money is numeric(18,6) and quantity numeric(20,6) (Inv. #68), returned as
// strings at the declared scale — `toEnvelope` canonicalizes them (pm71).
export const popUsageRate = product.table(
  "pop_usage_rate",
  {
    productOfferingPriceId: text("product_offering_price_id").notNull(),
    componentType: text("component_type")
      .notNull()
      .default("usage_rate")
      .$type<ComponentType>(),
    ratePerUnit: numeric("rate_per_unit", {
      mode: "string",
      precision: 18,
      scale: 6,
    }).notNull(),
    // A rate-card NAME, never a reference — no FK (Inv. #42).
    rateCardLookup: text("rate_card_lookup"),
  },
  (t) => [
    primaryKey({
      name: "pop_usage_rate_pkey",
      columns: [t.productOfferingPriceId],
    }),
    foreignKey({
      columns: [t.productOfferingPriceId, t.componentType],
      foreignColumns: [
        productOfferingPrice.productOfferingPriceId,
        productOfferingPrice.componentType,
      ],
      name: "pop_usage_rate_header_fk",
    }).onDelete("cascade"),
    check("pop_usage_rate_type_check", sql`component_type = 'usage_rate'`),
    check("pop_usage_rate_rate_check", sql`rate_per_unit >= 0`),
    check(
      "pop_usage_rate_lookup_check",
      sql`rate_card_lookup IS NULL OR btrim(rate_card_lookup) <> ''`,
    ),
  ],
);

export const popFlatFee = product.table(
  "pop_flat_fee",
  {
    productOfferingPriceId: text("product_offering_price_id").notNull(),
    componentType: text("component_type")
      .notNull()
      .default("flat_fee")
      .$type<ComponentType>(),
    amount: numeric("amount", {
      mode: "string",
      precision: 18,
      scale: 6,
    }).notNull(),
  },
  (t) => [
    primaryKey({
      name: "pop_flat_fee_pkey",
      columns: [t.productOfferingPriceId],
    }),
    foreignKey({
      columns: [t.productOfferingPriceId, t.componentType],
      foreignColumns: [
        productOfferingPrice.productOfferingPriceId,
        productOfferingPrice.componentType,
      ],
      name: "pop_flat_fee_header_fk",
    }).onDelete("cascade"),
    check("pop_flat_fee_type_check", sql`component_type = 'flat_fee'`),
    check("pop_flat_fee_amount_check", sql`amount >= 0`),
  ],
);

export const popCapacityCommitment = product.table(
  "pop_capacity_commitment",
  {
    productOfferingPriceId: text("product_offering_price_id").notNull(),
    componentType: text("component_type")
      .notNull()
      .default("capacity_commitment")
      .$type<ComponentType>(),
    committedQuantity: numeric("committed_quantity", {
      mode: "string",
      precision: 20,
      scale: 6,
    }).notNull(),
  },
  (t) => [
    primaryKey({
      name: "pop_capacity_commitment_pkey",
      columns: [t.productOfferingPriceId],
    }),
    foreignKey({
      columns: [t.productOfferingPriceId, t.componentType],
      foreignColumns: [
        productOfferingPrice.productOfferingPriceId,
        productOfferingPrice.componentType,
      ],
      name: "pop_capacity_commitment_header_fk",
    }).onDelete("cascade"),
    check(
      "pop_capacity_commitment_type_check",
      sql`component_type = 'capacity_commitment'`,
    ),
    check(
      "pop_capacity_commitment_quantity_check",
      sql`committed_quantity > 0`,
    ),
  ],
);

// One row per band. The PK rejects a duplicate threshold; strict ascent is
// `ORDER BY above_quantity` — no step_no (§6.44). `capacity_motivation` has no
// 1:1 table: its data IS its steps.
export const popMotivationStep = product.table(
  "pop_motivation_step",
  {
    productOfferingPriceId: text("product_offering_price_id").notNull(),
    componentType: text("component_type")
      .notNull()
      .default("capacity_motivation")
      .$type<ComponentType>(),
    aboveQuantity: numeric("above_quantity", {
      mode: "string",
      precision: 20,
      scale: 6,
    }).notNull(),
    ratePerUnit: numeric("rate_per_unit", {
      mode: "string",
      precision: 18,
      scale: 6,
    }).notNull(),
  },
  (t) => [
    primaryKey({
      name: "pop_motivation_step_pk",
      columns: [t.productOfferingPriceId, t.aboveQuantity],
    }),
    foreignKey({
      columns: [t.productOfferingPriceId, t.componentType],
      foreignColumns: [
        productOfferingPrice.productOfferingPriceId,
        productOfferingPrice.componentType,
      ],
      name: "pop_motivation_step_header_fk",
    }).onDelete("cascade"),
    check(
      "pop_motivation_step_type_check",
      sql`component_type = 'capacity_motivation'`,
    ),
    check("pop_motivation_step_quantity_check", sql`above_quantity > 0`),
    check("pop_motivation_step_rate_check", sql`rate_per_unit >= 0`),
  ],
);

// One row per characteristic, natural PK, no surrogate id. `displayOrder` is
// 1…n per specification (Inv. #66) — the author's entry order from pm72 on;
// 0056's backfill froze the pre-update jsonb key order into it. Every read
// orders by it; it never appears in a read model (§2.32).
export const productSpecCharacteristic = product.table(
  "product_spec_characteristic",
  {
    productSpecId: text("product_spec_id").notNull(),
    charName: text("char_name").notNull(),
    charValue: text("char_value").notNull(),
    displayOrder: integer("display_order").notNull(),
  },
  (t) => [
    primaryKey({
      name: "product_spec_characteristic_pk",
      columns: [t.productSpecId, t.charName],
    }),
    foreignKey({
      columns: [t.productSpecId],
      foreignColumns: [productSpecifications.productSpecId],
      name: "product_spec_characteristic_spec_fk",
    }).onDelete("cascade"),
    unique("product_spec_characteristic_order_unique").on(
      t.productSpecId,
      t.displayOrder,
    ),
    check("product_spec_characteristic_name_check", sql`char_name <> ''`),
  ],
);

// The codebase's first `relations()` (pm70 D11, code-standards §2.27) — for
// pm71/pm72's single-query `db.query.*` detail reads (§3.24); nothing in pm70
// calls them. `type` (the sixth price relation) lets `toEnvelope` take
// appliesAt / basis / pla_spec_id from the reference table inside that one
// query (§1.59) instead of a TypeScript constant. Drizzle resolves a `many`
// through the child's `one`, so each child declares its inverse.
export const productOfferingPriceRelations = relations(
  productOfferingPrice,
  ({ one, many }) => ({
    offering: one(productOffering, {
      fields: [productOfferingPrice.productOfferingId],
      references: [productOffering.productOfferingId],
    }),
    type: one(priceComponentType, {
      fields: [productOfferingPrice.componentType],
      references: [priceComponentType.componentType],
    }),
    usageRate: one(popUsageRate),
    flatFee: one(popFlatFee),
    capacityCommitment: one(popCapacityCommitment),
    motivationSteps: many(popMotivationStep),
  }),
);

export const popUsageRateRelations = relations(popUsageRate, ({ one }) => ({
  header: one(productOfferingPrice, {
    fields: [popUsageRate.productOfferingPriceId],
    references: [productOfferingPrice.productOfferingPriceId],
  }),
}));

export const popFlatFeeRelations = relations(popFlatFee, ({ one }) => ({
  header: one(productOfferingPrice, {
    fields: [popFlatFee.productOfferingPriceId],
    references: [productOfferingPrice.productOfferingPriceId],
  }),
}));

export const popCapacityCommitmentRelations = relations(
  popCapacityCommitment,
  ({ one }) => ({
    header: one(productOfferingPrice, {
      fields: [popCapacityCommitment.productOfferingPriceId],
      references: [productOfferingPrice.productOfferingPriceId],
    }),
  }),
);

export const popMotivationStepRelations = relations(
  popMotivationStep,
  ({ one }) => ({
    header: one(productOfferingPrice, {
      fields: [popMotivationStep.productOfferingPriceId],
      references: [productOfferingPrice.productOfferingPriceId],
    }),
  }),
);

export const productSpecificationsRelations = relations(
  productSpecifications,
  ({ many }) => ({
    characteristics: many(productSpecCharacteristic),
  }),
);

export const productSpecCharacteristicRelations = relations(
  productSpecCharacteristic,
  ({ one }) => ({
    specification: one(productSpecifications, {
      fields: [productSpecCharacteristic.productSpecId],
      references: [productSpecifications.productSpecId],
    }),
  }),
);

// pm57-spec D2/I1/I2 — physical DDL of record is
// db/migrations/0041_ratecard_ran_usage_lkp.sql; this is the hand-synced
// mirror (no drizzle-kit generate, code-standards §6.25). One row per
// upload. `snapshotDate` is the upload date in the app timezone, set by the
// upload service (D-A8) — NEVER read from the file, NEVER used for matching.
// No `carriedRowCount` (D-A7). `status = 'REJECTED'` and `rejectSummary` have
// no writer in this delivery (code-standards §1.42) — a failed upload writes
// nothing, including no version row. Both exist for a future asynchronous
// ingest.
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
    status: text("status").notNull().$type<RateCardVersionStatus>(),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    sourceFile: text("source_file").notNull(),
    fileChecksum: text("file_checksum"),
    rowCount: integer("row_count").notNull(),
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
    // pm58-spec D6 — the bounded reject-summary contract lands its inferred
    // (output) type here; no path writes it in this delivery (§1.42).
    rejectSummary: jsonb("reject_summary").$type<RejectSummary>(),
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
    // At most one open DRAFT per card (C8, option A). A wrong draft is
    // replaced by the next upload (D-A11, pm61 D12) — it does not block the
    // card; `deleteDraftVersion` (db/repositories/ratecard.ts) discards the
    // open draft so the re-upload can take its place. Mirrors the 0041
    // migration comment.
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
// subscription's removal. `polygonStartDate`/`polygonEndDate` are descriptive
// validity-window dates and `state`/`district` are descriptive labels — NOT
// part of the row key (D-A9/D-A10). `serviceCode` and `ratePerUnit` are plain
// columns with no CHECK and no meaning — stored as uploaded, nothing consumes
// them (D3/D4, code-standards §1.45/§3.2). No `retiredAt`/`carriedRowCount`
// (D-A7), no capacity column, no currency column (RC4, Inv. #53).
export const ratecardRanUsageLkp = product.table(
  "ratecard_ran_usage_lkp",
  {
    ratecardRanUsageLkpId: uuid("ratecard_ran_usage_lkp_id")
      .primaryKey()
      .default(sql`core.generate_ulid()`),
    ratecardVersionId: text("ratecard_version_id").notNull(),
    mnoPublicKey: text("mno_public_key").notNull(),
    commercialUnitPublicKey: text("commercial_unit_public_key").notNull(),
    polygonId: text("polygon_id").notNull(),
    polygonStartDate: date("polygon_start_date", { mode: "string" }).notNull(),
    polygonEndDate: date("polygon_end_date", { mode: "string" }),
    state: text("state"),
    district: text("district"),
    lkpSubscriberRefId: text("lkp_subscriber_ref_id").notNull(),
    serviceCode: text("service_code"),
    ratePerUnit: numeric("rate_per_unit", {
      mode: "string",
      precision: 18,
      scale: 6,
    }),
  },
  (t) => [
    // Explicit FK name — Drizzle's derived name exceeds Postgres's 63-byte
    // identifier cap (code-standards §"Constraint & index naming").
    foreignKey({
      columns: [t.ratecardVersionId],
      foreignColumns: [ratecardVersion.ratecardVersionId],
      name: "ratecard_ran_usage_lkp_ratecard_version_id_fk",
    }).onDelete("cascade"),
    // RV2 (D-A9): row identity within a version is
    // (mno_public_key, commercial_unit_public_key, polygon_id) —
    // polygon_start_date is out of the key. This version-scoped uniqueness
    // index is the only lookup index; there is no separate as-of index.
    unique("ratecard_ran_usage_lkp_row_key_unique").on(
      t.ratecardVersionId,
      t.mnoPublicKey,
      t.commercialUnitPublicKey,
      t.polygonId,
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
