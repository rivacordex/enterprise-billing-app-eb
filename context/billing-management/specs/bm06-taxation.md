# bm06 — Taxation — Spec

**Unit:** bm06 (`bm00-build-plan.md`). **Boundary:** `billing` schema + detail read. **Depends on:** bm05 (`customer_bill`, Aggregation, Customers & Bills tab).
**Grounded in** `F:/Projects/enterprise-billing-app/`: the billing-table + partman idioms (bm02–bm05); `lib/config.ts` (`z`-parsed env); the currency formatter; `bill_run.ref_tax_rate_version` (plan §6.1). **No billing tax-rate catalog table exists** (GST hits the ledger via `sys.tax_payable` on the posting side), so v1 taxation uses a **configured rate + version**.

> **v1 tax model (resolved by the codebase):** a single **configured GST rate** (default `8.00%`, version `GST-2026`) — **no tax-rate catalog table** in v1 (deferred with the rating engine). `bill_run.ref_tax_rate_version` is stamped once per run for provenance; tax is computed on the bm05 **synthetic stub subtotal**.

---

## Goal

The **Taxation** stage applies the run's tax-rate version (a configured **GST** rate in v1) to each draft bill's subtotal, writing per-bill `billing.customer_bill_tax_item` rows and stamping `tax_total` and `total_amount` on `customer_bill`; the Customers & Bills view shows the tax line items and the tax-inclusive total.

---

## Design

### Structural
- **New table `billing.customer_bill_tax_item`** — monthly `pg_partman`-partitioned on `period_partition`; **no JSONB** (financially significant, plan §6.4). Columns: `customer_bill_tax_item_id` (`CBT…`), `ref_customer_bill_id`, `period_partition` date, `tax_category` text, `tax_rate` `numeric(5,2)`, `tax_amount` `numeric(18,2)`. **Composite PK `(customer_bill_tax_item_id, period_partition)`**; FK `ref_customer_bill_id` → `customer_bill` (composite, includes `period_partition`). Register with partman (extend the billing bootstrap).
- **Tax-rate source (v1):** config `BILLRUN_TAX_RATE` (default `8.00`) and `BILLRUN_TAX_VERSION` (default `GST-2026`), plus `BILLRUN_TAX_CATEGORY` (default `GST`). **No catalog table.** `bill_run.ref_tax_rate_version` is stamped once (idempotent, uniform per run) with `BILLRUN_TAX_VERSION` — at first taxation if still null (or at trigger; either way one version per run).
- **Taxation stage (stage 6 — the `taxation` signal)** `services/billing/taxation.ts`: for each account's `trial` bill, compute `tax_amount = round(subtotal * rate / 100, 2)` **in SQL** (`numeric`, never JS float; Postgres `round()` half-up), write one `customer_bill_tax_item` (`tax_category = 'GST'`, `tax_rate`, `tax_amount`), then `UPDATE customer_bill SET tax_total = <sum of its tax items>, total_amount = subtotal + tax_total`. Deterministic (the stub subtotal is deterministic ⇒ tax is too). **Rerun-safe:** `DELETE` the bill's tax items + re-insert and recompute totals, all guarded by `ref_inv_document_id IS NULL` (never re-taxes a posted bill). Invoked via the bm04 ingest on the `taxation` stage signal.
- **Multiple tax categories** are supported by the row shape (one row per category) though v1 writes a single `GST` row; `tax_total` is always the SQL sum of the bill's items, never a scalar shortcut.

### Visual (`billmgmt-ui-context.md`)
- The Customers & Bills row expander (bm05) gains a **Tax** section: each `customer_bill_tax_item` as `{category} @ {rate}% → {amount}` (tabular-nums, `lib/` currency formatter), and the row total now shows **subtotal + tax = total** (tax-inclusive). `StubDataBanner` still marks figures as fixtures.

---

## Implementation

### 1. Schema — `db/schema/billing/customer-bill-tax-item.ts` (+ migration + partman)
Drizzle typing (composite PK on the partition key), `CBT` id default + `customerBillTaxItemSeq`, the composite FK to `customer_bill`. Export from `db/schema/index.ts`. Custom SQL migration (`PARTITION BY RANGE (period_partition)` + default partition). Extend `db/bootstrap/billing-partman-setup.sql` with the `customer_bill_tax_item` registration (monthly, 7-year detach).

### 2. Config — `lib/config.ts`
Add `BILLRUN_TAX_RATE: z.coerce.number().min(0).max(100).default(8)`, `BILLRUN_TAX_VERSION: z.string().default("GST-2026")`, `BILLRUN_TAX_CATEGORY: z.string().default("GST")`. Document in `.env.example`. (Rate is applied as `numeric` in SQL, not JS float — the config value only parameterises the SQL expression.)

### 3. Taxation service — `services/billing/taxation.ts`
`taxBill(tx, run, banId)` — resolve the bill (`ref_inv_document_id IS NULL` guard), stamp `bill_run.ref_tax_rate_version` if null, `DELETE` existing tax items for the bill, `INSERT` the GST item with `tax_amount = round(subtotal * :rate / 100, 2)`, `UPDATE customer_bill` totals from the SQL sum. Framework-agnostic (`tx`, no `next/*`). Returns the updated bill totals.

### 4. Bill view — `components/billing/customer-bill-table.tsx`
Extend the bm05 expander with the tax lines + the tax-inclusive total via the read model (`CustomerBillRow` gains `taxItems: { category, rate, amount }[]` and `taxTotal`). Read service `list-account-bills.ts` joins the tax items.

### 5. Tests — `tests/…`
- Taxation writes one `GST` `customer_bill_tax_item` per bill with `tax_amount = round(subtotal * 8 / 100, 2)`; `customer_bill.tax_total` = the SQL sum; `total_amount = subtotal + tax_total`. Deterministic (same stub subtotal → same tax).
- **No JS float:** the computation is a SQL `numeric` expression; a property test confirms `tax_total` equals the summed items to the cent.
- **Rerun-safe:** re-taxing an unposted bill replaces its tax items and recomputes totals; a bill with `ref_inv_document_id` set is never re-taxed.
- `bill_run.ref_tax_rate_version` is stamped once and is uniform across the run's bills.
- Partman partition present; composite FK to `customer_bill` holds; route × level for the tab (`billrun_view`).

---

## Dependencies (packages to install)

**None.** Reuses `drizzle-orm`/`zod`; the currency formatter exists; pg_partman provisioned. Tax arithmetic is SQL `numeric` — no decimal library needed.

---

## Verification checklist

Schema
- [ ] Migration creates `billing.customer_bill_tax_item` RANGE-partitioned on `period_partition`, composite PK, composite FK to `customer_bill`, `tax_rate numeric(5,2)`/`tax_amount numeric(18,2)`; partman-registered; `db:migrate` + partman clean; typecheck/lint/format clean; no new dependency.

Taxation (the visible result)
- [ ] Each `trial` bill gets one `GST @ 8.00%` tax item; `tax_amount = round(subtotal * 8/100, 2)`; `customer_bill.tax_total` = sum of items; `total_amount = subtotal + tax_total`.
- [ ] The Customers & Bills expander shows the tax line(s) and the tax-inclusive total (tabular-nums, currency-formatted).
- [ ] `bill_run.ref_tax_rate_version` = `BILLRUN_TAX_VERSION`, stamped once, uniform per run.
- [ ] Tax is computed in SQL `numeric` (no JS float); `tax_total` equals the summed items to the cent.

Rerun-safety
- [ ] Re-taxing an unposted bill replaces its tax items and recomputes totals; a posted bill (`ref_inv_document_id` set) is never re-taxed.

Discipline
- [ ] No verification/Uncharged/Errors/posting logic here (bm07, bm11); docs updated same change set (`billmgmt-code-standards.md` §8 bm06 row + `billmgmt-progress-tracker.md`).
