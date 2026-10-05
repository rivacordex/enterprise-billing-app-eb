-- bm41-spec §Design/§Implementation §1 (Target Capacity Pricing update, Unit 1).
-- Schema-before-behavior: adds the two columns bm42 (capacity aggregation) and
-- bm45 (invoice appendix) need. `rated_amount` is the rated side of the
-- reconciliation (NULL for RECURRING; = gross_amount on non-capacity USAGE;
-- the sum of the rated rows on a capacity line). `additional_info` is the
-- versioned calc trace (capacity lines only, NULL elsewhere this phase) —
-- never hashed (Inv #35). Both nullable; no new `source`/`line_type` CHECK.
--
-- `customer_bill_line` is range-partitioned on `period_partition`; this
-- `ALTER TABLE` on the parent propagates to every partition — no per-partition
-- DDL (verify on the parent AND a live partition at apply time).
ALTER TABLE "billing"."customer_bill_line"
  ADD COLUMN "rated_amount" numeric(18, 2),
  ADD COLUMN "additional_info" jsonb;
