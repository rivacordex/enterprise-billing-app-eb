# bm23 — `customer_bill_line` Schema, Partitions & Grants

**Unit:** bm23 (Phase 3 · Phase J). **Boundary:** `billing` schema (`db/migrations/0039`, `db/schema/billing/customer-bill-line.ts`) + `db/bootstrap` (partman registration, grants) + its guardrail test. **No repository, flow task, or UI** (`billmgmt-ai-workflow-rules.md` §4.2 — the schema lands and verifies alone). **Specs from:** `billmgmt-architecture.md` §6 (Inv #3, #4, #16, #23), `billmgmt-code-standards.md` §2 / §6, `_updatemodule-billing-billrun-phase3-plan.md` **D5/D7/D22/D27**, `bm00-build-plan.md` Unit 23. **Model files:** `db/migrations/0029_customer_bill.sql` (partitioned-table pattern) + `db/migrations/0030_customer_bill_tax_item.sql` (composite-FK `ON DELETE CASCADE`).

> **Framing.** `customer_bill_line` **is the bill's charge record** — not a copy, not a projection (Inv #3, the §0 reversal of the old "no billing-side charge table" rule). It holds disaggregated charge lines at the `(product_offering_id, udr_type)` grain, one row per aggregated charge, whose three money columns roll up into `customer_bill.subtotal`. This unit introduces the table, its partitioning, and its grant boundary **only** — no code reads or writes it yet. It ships between bm22 (which proved the environment) and bm24+ (which consume it), so the schema and its two-writer boundary are proven in isolation before any aggregation logic depends on them.

## Goal

Create the partitioned `billing.customer_bill_line` table at the finest charge grain, with a composite PK, a composite `ON DELETE CASCADE` FK to `customer_bill`, the `BLN` sequence, `source`/`line_type` CHECKs, the three money columns, the `udr_rated`-shaped discount columns, `udr_count` + grouping key, the recurring price-snapshot columns, and `currency`; register it as the seventh `pg_partman` parent (monthly, 7-year detach-and-archive); and set its grants so `app_runtime` can **read but not write** it and `billrun_runtime` can **insert and read but not delete** it — verified per column and table by the `billrun-db-roles` integration suite.

## Design

**Structural decisions**

- **The charge record, at `(product_offering_id, udr_type)` grain (Inv #3).** One row per aggregated charge; the three money columns (`gross_amount`, `discount_amount`, `net_amount`) are the bill's authoritative amounts, and `customer_bill.subtotal = SUM(net_amount)` (enforced by aggregation, bm28 — not a constraint here).
- **Composite FK with `ON DELETE CASCADE` (D22, §6.5).** FK `(ref_customer_bill_id, period_partition) → customer_bill(customer_bill_id, period_partition)` **cascades on delete** — mirroring `customer_bill_tax_item` (0030), **not** `bill_run_invoices` (0036, which uses `ON DELETE RESTRICT` because it is immutable). The cascade is load-bearing: the whole-account replace (bm28) deletes the trial `customer_bill` row through `billrun_delete_trial_bill`, and the lines vanish with it — never a per-line `DELETE` or upsert (Inv #16).
- **No row trigger on the lines (D27, §6.8).** Unlike `bill_run_invoices`' unconditional immutability guard (0036) and `customer_bill`'s finalization guard (0033), `customer_bill_line` carries **no** trigger. The header's finalization guard already makes a finalized `customer_bill` un-deletable, so its lines can never cascade away; line integrity past posting is the app-layer latch + the content checksum (bm31), not a DB trigger.
- **No business `UNIQUE` on `(bill, offering, udr_type)` (Unit 23 note, Inv #16).** Exactly-once is the **whole-account replace**, not a row constraint. A unique index would fight the delete-then-insert re-derivation and give a false sense that per-line upsert is allowed. Deliberately absent.
- **Two-writer boundary as columns, again (Inv #3 / §6.3).** `billrun_runtime` inserts and reads; `app_runtime` reads only. Crucially, `bootstrap-db-roles.sql`'s `ALTER DEFAULT PRIVILEGES … TO app_runtime` auto-grants `app_runtime` full DML on **every new** `billing` table — so this unit must **explicitly revoke** `INSERT/UPDATE/DELETE` from `app_runtime` on `customer_bill_line`, leaving `SELECT`, exactly as bm14 Step 6a did for `customer_bill_tax_item`. `billrun_runtime` holds **no** default privileges (bm14 Step 11), so it gets only what this unit grants — `SELECT` + column-scoped `INSERT`, **no** `DELETE` (the cascade runs under the `SECURITY DEFINER` owner, not the caller's grant).
- **Schema-only; the TS unions land with their consumer.** The Drizzle file exists for query typing (Drizzle can't express `PARTITION BY` or the composite PK — `do not drizzle-kit push`). The shared `types/billing.ts` `ChargeSource`/`LineType` unions and any `BLN` constant are introduced by their **first consumer** (bm28's `BillLineTable`); here the DB CHECKs are the authoritative source of the allowed values.

## Implementation

### 1. `db/migrations/0039_customer_bill_line.sql` (new — hand-authored, partitioned)

Following `0029`/`0030` exactly (Drizzle can't express partitioning). Sequence, table, the two FK/partition-key indexes, bootstrap default partition — no trigger, no business `UNIQUE`:

```sql
-- bm23-spec §Implementation §1. billing.customer_bill_line — the bill's charge
-- record at (product_offering_id, udr_type) grain (Inv #3). PARTITION BY RANGE
-- (period_partition) via pg_partman (billing-partman-setup.sql), same pattern as
-- customer_bill (0029). Composite FK to customer_bill ON DELETE CASCADE (D22) so
-- the whole-account replace (bm28) removes lines with the header. NO row trigger
-- (D27) and NO business UNIQUE on (bill, offering, udr_type) — exactly-once is the
-- whole-account replace, not a constraint (Inv #16).
CREATE SEQUENCE "billing"."customer_bill_line_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
--> statement-breakpoint
CREATE TABLE "billing"."customer_bill_line" (
  "customer_bill_line_id" text DEFAULT 'BLN' || lpad(nextval('billing.customer_bill_line_seq')::text, 8, '0') NOT NULL,
  "ref_customer_bill_id"  text NOT NULL,
  "period_partition"      date NOT NULL,
  "line_no"               integer NOT NULL,
  "source"                text NOT NULL,
  "line_type"             text NOT NULL DEFAULT 'charge',
  "ref_product_offering_id" text NOT NULL,     -- plain-text ref, no cross-schema FK (architecture §1)
  "udr_type"              text,                 -- USAGE only; NULL for RECURRING
  "description"           text,
  "quantity"              numeric(20, 6),
  "unit"                  text,
  "gross_amount"          numeric(18, 2) NOT NULL,
  "discount_amount"       numeric(18, 2) NOT NULL DEFAULT '0.00',
  "net_amount"            numeric(18, 2) NOT NULL,
  "discount_type"         text,                 -- udr_rated-shaped (0034): 'fixed'|'percentage'
  "discount_rate"         numeric(18, 6),
  "discount_amount_raw"   numeric(18, 6),
  "udr_count"             integer,              -- USAGE: count of udr_rated rows rolled into this line
  "grouping_key"          text NOT NULL,        -- deterministic line_no ordering + reconciliation replay (bm30)
  "currency"              char(3) NOT NULL,
  "snapshot_price_ref"        text,             -- RECURRING price snapshot (D19), NULL for USAGE
  "snapshot_unit_price"       numeric(18, 6),
  "snapshot_quantity"         numeric(20, 6),
  "snapshot_effective_date"   date,
  CONSTRAINT "customer_bill_line_pk" PRIMARY KEY ("customer_bill_line_id","period_partition"),
  CONSTRAINT "customer_bill_line_customer_bill_fk"
    FOREIGN KEY ("ref_customer_bill_id","period_partition")
    REFERENCES "billing"."customer_bill" ("customer_bill_id","period_partition") ON DELETE CASCADE,
  CONSTRAINT "customer_bill_line_source_check"    CHECK (source IN ('USAGE','RECURRING','OCC')),
  CONSTRAINT "customer_bill_line_line_type_check" CHECK (line_type IN ('charge','discount','adjustment')),
  CONSTRAINT "customer_bill_line_discount_type_check" CHECK (discount_type IS NULL OR discount_type IN ('fixed','percentage'))
) PARTITION BY RANGE ("period_partition");
--> statement-breakpoint
-- Index the FK child columns (0030 precedent) — Postgres does not auto-index the
-- referencing side, so the ON DELETE CASCADE from the whole-account replace (bm28)
-- would seq-scan without it.
CREATE INDEX "customer_bill_line_ref_customer_bill_id_idx" ON "billing"."customer_bill_line" USING btree ("ref_customer_bill_id");
--> statement-breakpoint
CREATE INDEX "customer_bill_line_period_partition_idx" ON "billing"."customer_bill_line" USING btree ("period_partition");
--> statement-breakpoint
CREATE TABLE "billing"."customer_bill_line_default" PARTITION OF "billing"."customer_bill_line" DEFAULT;
```

`source`/`line_type` CHECKs admit all forward-compat values (`OCC` reserved-unbuilt, `discount`/`adjustment` unbuilt this phase — §3) exactly as `customer_bill.category`/`state` admit their full sets. `ref_product_offering_id` carries **no** FK (the reserved-ref pattern `customer_bill.ref_bill_format_id` established) — `billrun_runtime`'s `SELECT` on `product.product_offering` is granted by bm28, not here.

### 2. `db/schema/billing/customer-bill-line.ts` (new — query typing only)

Mirror `db/schema/billing/customer-bill.ts`: declare the `customerBillLineSeq` (`BLN` default) and the columns for Drizzle query typing, with the same **"do not `drizzle-kit push`"** header comment — the physical DDL of record is `0039`; this file exists so services can type-select the table. No composite PK / FK / partition expressed (Drizzle can't).

### 3. `db/bootstrap/billing-partman-setup.sql` — register the seventh parent

After the `bill_run_distribution` block (currently the sixth parent), add an idempotent `partman.create_parent('billing.customer_bill_line', p_control := 'period_partition', p_interval := '1 month', p_type := 'range', p_premake := 4, p_default_table := false)` + the `part_config` retention update (`retention := '7 years'`, `retention_keep_table := true`, `premake := 4`, `infinite_time_partitions := true`) — identical to the other six. Update the "six parents"/"seven parents" tally comments so the maintenance sweep covers it.

### 4. `db/bootstrap/billrun-db-roles.sql` — grants (role/grant lives here, not a migration — §6.5)

- **Sequence USAGE** — extend Step 4 with `GRANT USAGE ON SEQUENCE "billing"."customer_bill_line_seq" TO billrun_runtime;`.
- **`billrun_runtime` — SELECT + column-scoped INSERT, no DELETE, no UPDATE.** A new step after the `customer_bill` block:
  ```sql
  GRANT SELECT ON TABLE "billing"."customer_bill_line" TO billrun_runtime;
  --> statement-breakpoint
  GRANT INSERT (
    "customer_bill_line_id","ref_customer_bill_id","period_partition","line_no",
    "source","line_type","ref_product_offering_id","udr_type","description",
    "quantity","unit","gross_amount","discount_amount","net_amount",
    "discount_type","discount_rate","discount_amount_raw","udr_count",
    "grouping_key","currency","snapshot_price_ref","snapshot_unit_price",
    "snapshot_quantity","snapshot_effective_date"
  ) ON TABLE "billing"."customer_bill_line" TO billrun_runtime;
  ```
  No table `DELETE` (the whole-account replace cascades from `customer_bill` under the `billrun_delete_trial_bill` `SECURITY DEFINER` owner); no `UPDATE` (re-derivation is delete-then-insert, never per-line update — Inv #16).
- **`app_runtime` — revoke the default-privileges DML, keep SELECT.** `bootstrap-db-roles.sql`'s `ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "billing" GRANT SELECT, INSERT, UPDATE, DELETE … TO app_runtime` auto-grants `app_runtime` full DML on this new table. Add an explicit `REVOKE INSERT, UPDATE, DELETE ON TABLE "billing"."customer_bill_line" FROM app_runtime;` (SELECT retained) — the boundary is grant-enforced, not "unused by convention" (bm14 Step 6a precedent).

### 5. Guardrail test — extend `tests/db/billrun-db-roles.integration.test.ts`

A new `customer_bill_line` describe block, mirroring the `customer_bill` one, asserting per column/table over role-specific connections:

- **`billrun_runtime` can:** `INSERT` a line (against a seeded trial `customer_bill`) and `SELECT` it.
- **`billrun_runtime` refused (per table):** any direct `DELETE` and any `UPDATE` on `customer_bill_line` → `permission denied for table customer_bill_line` (asserting the whole-account-replace discipline structurally).
- **`app_runtime` can:** `SELECT`.
- **`app_runtime` refused (per table):** `INSERT`/`UPDATE`/`DELETE` → `permission denied` (proving the default-privileges revoke held).
- **Cascade:** deleting the parent `customer_bill` (via `billrun_delete_trial_bill`) removes the line (cascade), while a finalized parent (`ref_inv_document_id` set) cannot be deleted, so its line survives — the D27/D22 interaction.
- **Partition:** extend `tests/db/billing-partman-setup.integration.test.ts` — a `customer_bill_line` row dated a future month lands in its own partition, not the default.

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm22 (migrations `0033`/`0035`–`0038` applied, `db:setup-partman-billing` runnable against real Postgres, the DB-gated suite executing); `billing.customer_bill` (bm05, delivered) for the composite FK; `billrun_runtime`/`app_runtime` (bm14 / platform bootstrap).
- **Env:** none new (`BOOTSTRAP_DATABASE_URL` for partman + grants; `DATABASE_URL`/role connection strings for the test — all existing).

## Verification checklist

- [ ] `0039_customer_bill_line.sql` applies on a real Postgres: `BLN` id default, composite PK, `ON DELETE CASCADE` FK to `customer_bill`, the three `source`/`line_type`/`discount_type` CHECKs, and the default partition — with **no** row trigger and **no** business `UNIQUE` on `(bill, offering, udr_type)`.
- [ ] `db:setup-partman-billing` registers `customer_bill_line` as the seventh parent (monthly, 7-year detach-and-archive); a future-month row lands in its own partition, not the default.
- [ ] The `billrun-db-roles` suite proves, per column/table: `app_runtime` can `SELECT` and cannot `INSERT`/`UPDATE`/`DELETE` (the default-privileges DML revoke held); `billrun_runtime` can `INSERT`/`SELECT` and cannot `DELETE`/`UPDATE`.
- [ ] Deleting a non-finalized `customer_bill` cascades its lines away; a finalized `customer_bill` (and thus its lines) cannot be deleted.
- [ ] `db/schema/billing/customer-bill-line.ts` carries the "do not `drizzle-kit push`" comment; `tsc`/lint green; no repository, flow, or UI added by this unit.
- [ ] `billmgmt-progress-tracker.md` records bm23 delivered; any value resolved during the build (e.g. exact snapshot column set) recorded in its owning doc.
