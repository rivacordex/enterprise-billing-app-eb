# bm41 — `customer_bill_line` capacity columns, Drizzle mirror & grants

**Unit:** bm41 (Target Capacity Pricing update). **Boundary:** one hand-authored migration + `db/schema/billing/customer-bill-line.ts` + `types/billing.ts` + `db/bootstrap/billrun-db-roles.sql`. **Schema + grants only — no behavior, no compute, no UI.** **Specs from:** `_updatemodule-billing-billrun-target-capacity-plan.md` §9 (data model), §10 (grants), TC19/TC23; `billmgmt-architecture.md` (Target Capacity deltas §Storage, Inv #35); `bm00-build-plan.md` Part 3 Unit 41. **Depends on:** bm40 (a runnable flow base).

> **Verified against `enterprise-billing-app` (2026-10-04):** `customer_bill_line.ts` carries **neither** `rated_amount` nor `additional_info`; `billrun_runtime` has `USAGE` on `product` and `SELECT` on `product_offering_price` (bm28/bm29) but **not** on `product_specifications` / the ratecard tables; the migration sequence tops out at `0043` (`0041`/`0043` taken, `0042` unused). The capacity plan's placeholder "`0041_customer_bill_line_capacity.sql`" is therefore wrong — use the next free number.

## Goal

Add `rated_amount numeric(18,2)` and `additional_info jsonb` to `billing.customer_bill_line` (hand-authored migration + Drizzle mirror + read-model type) and grant `billrun_runtime` read access to the product-spec and ratecard tables, so the capacity aggregation (bm42) and the invoice appendix (bm45) have the columns and cross-schema reads they need — landing and verifying **alone**, before any consumer.

## Design

- **Schema before behavior.** This unit ships the columns + grants and nothing else (mirrors the delivered bm23). bm42 is the first consumer; it must build on a proven schema.
- **`rated_amount numeric(18,2)` → `string`** — the rated side of the reconciliation: NULL for RECURRING lines; `= gross_amount` on non-capacity USAGE lines; the sum of the rated rows on a capacity line. Nullable (RECURRING carries NULL).
- **`additional_info jsonb`** — set on capacity lines only (NULL elsewhere this phase); the versioned calc trace written by bm42 (`{ v, productInventoryId, pricing, calc[], summary[] }`). **Never hashed** (Inv #35) — verification binds it to the hashed columns. The column is plain `jsonb`; the shape is enforced in the writer (bm42) and the read-model type, not by a DB CHECK (financially significant data stays in first-class columns; this is a trace, not a money field — §6.14).
- **No new `source`/`line_type` CHECK** — capacity lines are `USAGE`/`charge`, already-valid enum values.
- **Partitioned parent.** `customer_bill_line` is range-partitioned on `period_partition`; an `ALTER TABLE … ADD COLUMN` on the parent propagates to every partition — no per-partition DDL.
- **Grants are per-table, in `billrun-db-roles.sql`, not a migration** — role/grant definitions live in bootstrap (code-standards §6 protected-files rule). Enumerated per table, never `ON ALL TABLES` (Inv #23); the grant change updates the architecture Invariants in the same change set.
- **Migration numbering** — next free after `0043`: **`0044_customer_bill_line_capacity.sql`** (confirm the hand-authored apply path / journal idx at implementation; do not reuse `0041`).

## Implementation

### 1. Migration — `db/migrations/0044_customer_bill_line_capacity.sql` (hand-authored, partitioned)

```sql
ALTER TABLE "billing"."customer_bill_line"
  ADD COLUMN "rated_amount"   numeric(18,2),
  ADD COLUMN "additional_info" jsonb;
```

- Both nullable; the parent `ALTER` propagates to partitions. No CHECK, no index this unit. Apply via the module's migrate path, then verify on the parent **and** a live partition.

### 2. Drizzle mirror — `db/schema/billing/customer-bill-line.ts`

- Add `ratedAmount: numeric(...)` and `additionalInfo: jsonb(...)` to the table definition for **query typing only**. The hand-authored migration is the DDL of record — do **not** `drizzle-kit push` this partitioned table (the module convention).

### 3. Read-model type — `types/billing.ts`

- Extend the `BillLineRow` read model with `ratedAmount: string | null` and `additionalInfo: CapacityCalcTrace | null`; declare `CapacityCalcTrace` as the versioned `{ v; productInventoryId; pricing; calc[]; summary[] }` shape (typing only — bm42/bm45 populate it).

### 4. Grants — `db/bootstrap/billrun-db-roles.sql`

- Add, alongside the existing `product_offering`/`product_offering_price` reads (Step "cross-schema reads"):

```sql
GRANT SELECT ON TABLE
  "product"."product_specifications",
  "product"."ratecard_ran_usage_lkp",
  "product"."ratecard_version"
TO billrun_runtime;
```

- `USAGE ON SCHEMA "product"` already held; **no** write grant of any kind on these tables. `app_runtime` already holds `SELECT` on `customer_bill_line` (phase-3 Finding 4), which covers the two new columns — no app-side grant needed. Re-run `db:bootstrap-billrun-roles`. (First confirm these three SELECTs are not already present.)

### 5. Doc sync

- `billmgmt-architecture.md` (Storage deltas + Inv #35) and `billmgmt-code-standards.md` §6 already describe the two columns and the grants; confirm both reference bm41 as the delivering unit.

## Dependencies

- **npm packages:** none.
- **Prerequisite artifacts:** bm40 (the flow runs again); `product.product_specifications` (`0006`), `product.ratecard_ran_usage_lkp` + `product.ratecard_version` (`0041`) — all delivered.
- **Downstream:** bm42 (needs both columns + the product-spec read), bm45 (needs `additional_info` + the ratecard grants). Neither may start until bm41 verifies.

## Verification checklist

- [ ] The migration applies on a disposable DB; `rated_amount` (`numeric(18,2)`, nullable) and `additional_info` (`jsonb`, nullable) exist on `billing.customer_bill_line` **and** on a live partition (parent `ALTER` propagated); no new `source`/`line_type` CHECK was added.
- [ ] `db/schema/billing/customer-bill-line.ts` + `types/billing.ts` compile; the `BillLineRow` read model exposes `ratedAmount` + `additionalInfo`; the schema is **not** `drizzle-kit push`ed.
- [ ] A grant assertion test confirms `billrun_runtime` holds `SELECT` on `product.product_specifications`, `product.ratecard_ran_usage_lkp`, `product.ratecard_version` — and **no** INSERT/UPDATE/DELETE on them; `app_runtime` still `SELECT`-only on `customer_bill_line`.
- [ ] No behavior change: a bill run produces the same bills as before (both new columns land NULL — nothing populates them until bm42).
- [ ] `tsc` / eslint / the DB-free unit suite green; the DB-gated schema + grant suites green on a disposable Postgres.
- [ ] Docs: `billmgmt-architecture.md` (Storage/Inv #35) and `billmgmt-code-standards.md` §6 name bm41 as the unit that adds the columns + grants; `bm00-build-plan.md` Part 3 Unit 41 unchanged.
