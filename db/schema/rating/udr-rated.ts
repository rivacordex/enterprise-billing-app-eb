import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { rating } from "@/db/schema/rating/pg-schema";
import type { UdrRateDetail } from "@/validation/rating/udr-rate-detail.schema";

// rm01-spec §Implementation §2. PHYSICAL DDL OF RECORD: db/migrations/0034_rating.sql
// This table is PARTITION BY RANGE (partition_period) via pg_partman
// (db/bootstrap/rating-partman-setup.{sql,ts}), following the `audit_log` /
// `bill_run_account` pattern exactly: Drizzle cannot express partitioning,
// the composite PK on a partitioned table, or the GENERATED column's CHECK
// cross-reference — this declaration exists for query typing only. Do not
// `drizzle-kit push` it.
//
// `partition_period` is a physical storage bucket keyed to UTC month
// boundaries, not the billing month (rm01-spec D3) — never derive it from a
// business-local calendar.
export const udrRated = rating.table(
  "udr_rated",
  {
    // ULID generated db-side by core.generate_ulid(), stored in uuid (16 bytes).
    udrId: uuid("udr_id")
      .notNull()
      .default(sql`core.generate_ulid()`),
    partitionPeriod: date("partition_period", { mode: "string" }).notNull(),
    udrType: text("udr_type").notNull(),
    // Full precision (no precision modifier) — half the natural key
    // (rm01-spec D5). Do not copy the `precision: 3` used on billing's
    // operational timestamps.
    startDatetime: timestamp("start_datetime", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    endDatetime: timestamp("end_datetime", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    status: text("status").notNull().default("RATED"),
    // GENERATED ALWAYS ... STORED from status (rm01-spec D4) — carries the
    // live-row uniqueness constraint. Live rows hold TRUE and collide;
    // superseded rows hold NULL and coexist under NULLS DISTINCT.
    isLive: boolean("is_live").generatedAlwaysAs(
      sql`CASE WHEN status IN ('RATED','BILL_DRAFT','BILL_APPROVED') THEN true END`,
    ),
    // No FK to inventory.product_inventory (Inv #17) — plain text.
    udrSubscriberRefId: text("udr_subscriber_ref_id").notNull(),
    udrKey: text("udr_key").notNull(),
    // Reserved, stays NULL in v1 (rm01-spec D10). Do not populate.
    udrResource: text("udr_resource"),
    udrUsageQuantity: numeric("udr_usage_quantity", {
      mode: "string",
      precision: 20,
      scale: 6,
    }).notNull(),
    udrUsageUnit: text("udr_usage_unit").notNull(),
    udrUsageRate: numeric("udr_usage_rate", {
      mode: "string",
      precision: 18,
      scale: 6,
    }),
    udrRateType: text("udr_rate_type").notNull(),
    // Zod-validated at the write boundary, discriminated by udr_rate_type
    // (validation/rating/udr-rate-detail.schema.ts).
    udrRateDetail: jsonb("udr_rate_detail").$type<UdrRateDetail>(),
    udrRatedPrice: numeric("udr_rated_price", {
      mode: "string",
      precision: 18,
      scale: 2,
    }).notNull(),
    udrRatedPriceRaw: numeric("udr_rated_price_raw", {
      mode: "string",
      precision: 18,
      scale: 6,
    }).notNull(),
    udrRoundingMode: text("udr_rounding_mode").notNull(),
    udrDiscountAmount: numeric("udr_discount_amount", {
      mode: "string",
      precision: 18,
      scale: 2,
    }),
    udrDiscountAmountRaw: numeric("udr_discount_amount_raw", {
      mode: "string",
      precision: 18,
      scale: 6,
    }),
    udrDiscountType: text("udr_discount_type"),
    udrDiscountRate: numeric("udr_discount_rate", {
      mode: "string",
      precision: 18,
      scale: 6,
    }),
    udrDiscountAuthorityRef: text("udr_discount_authority_ref"),
    // Matches billing_account.currency shape (accounts.ts).
    udrCurrency: char("udr_currency", { length: 3 }).notNull(),
    udrSubscriptionRateplanRef: text("udr_subscription_rateplan_ref"),
    // No FK to product.product_offering_price (Inv #17) — plain text.
    udrPriceRef: text("udr_price_ref"),
    udrPriceEffectiveDate: timestamp("udr_price_effective_date", {
      withTimezone: true,
      mode: "date",
    }),
    // No FK to ordering.order_item_price_override (Inv #17) — plain text.
    udrPriceOverrideRef: text("udr_price_override_ref"),
    // Written by the bill run (billing repo) via a column-scoped grant
    // (ratemgmt-code-standards.md §9) — not this module.
    billrunRefId: text("billrun_ref_id"),
    billrunBanId: text("billrun_ban_id"),
    billrunAttempt: integer("billrun_attempt"),
    billrunChecksum: text("billrun_checksum"),
    // No FK to rating.udr_batch (Inv #17) — plain text. The single lineage
    // anchor (rm01-spec D11); batch-level columns (batch_run_num,
    // supersede_reason, superseded_by_batch_id) live on udr_batch instead.
    udrRefBatchId: text("udr_ref_batch_id").notNull(),
    // Kept for self-explaining rows despite being derivable (rm01-spec D11).
    udrSourceFile: text("udr_source_file").notNull(),
    ratingEngineVersion: text("rating_engine_version").notNull(),
    ratingFlowRevision: integer("rating_flow_revision").notNull(),
    udrLoaderInstanceId: text("udr_loader_instance_id"),
    ratedDatetime: timestamp("rated_datetime", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    insertDatetime: timestamp("insert_datetime", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    upsertDatetime: timestamp("upsert_datetime", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
  },
  (t) => [
    // Composite PK is required because partition_period is the partition key
    // (Postgres requires the partition key in every unique/PK on a
    // partitioned table).
    primaryKey({ name: "udr_rated_pk", columns: [t.partitionPeriod, t.udrId] }),
    // The live-row uniqueness constraint (Inv #3) — the only thing that makes
    // double-billing structurally impossible. Do not drop, weaken, or make
    // deferrable.
    unique("udr_rated_live_uq").on(
      t.partitionPeriod,
      t.startDatetime,
      t.udrKey,
      t.isLive,
    ),
    check("udr_rated_udr_key_length_check", sql`char_length(udr_key) <= 512`),
    check(
      "udr_rated_period_matches_check",
      sql`partition_period = rating.period_of(start_datetime)`,
    ),
    check(
      "udr_rated_status_check",
      sql`status IN ('RATED','BILL_DRAFT','BILL_APPROVED','REJECTED','SUPERSEDED','BILL_NOTUSED')`,
    ),
    check(
      "udr_rated_rate_type_check",
      sql`udr_rate_type IN ('FLAT','PER_UNIT','TIERED_GRADUATED','TIERED_VOLUME','BLOCK','PERCENTAGE','ZERO_RATED')`,
    ),
    check(
      "udr_rated_discount_type_check",
      sql`udr_discount_type IS NULL OR udr_discount_type IN ('fixed','percentage')`,
    ),
    check(
      "udr_rated_rounding_mode_check",
      sql`udr_rounding_mode IN ('HALF_UP','HALF_EVEN','TRUNCATE')`,
    ),
    check(
      "udr_rated_end_after_start_check",
      sql`end_datetime >= start_datetime`,
    ),
    index("udr_rated_subscriber_start_idx").on(
      t.udrSubscriberRefId,
      t.startDatetime,
    ),
    index("udr_rated_billrun_idx")
      .on(t.billrunRefId, t.billrunBanId, t.billrunAttempt)
      .where(sql`billrun_ref_id IS NOT NULL`),
    index("udr_rated_batch_idx").on(t.udrRefBatchId),
    index("udr_rated_orphan_idx")
      .on(t.udrKey)
      .where(sql`is_live IS NULL`),
  ],
);

export type UdrRated = typeof udrRated.$inferSelect;
export type UdrRatedInsert = typeof udrRated.$inferInsert;
