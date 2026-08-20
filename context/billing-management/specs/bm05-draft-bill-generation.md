# bm05 — Draft bill generation (Claim + Aggregation) — Spec

**Unit:** bm05 (`bm00-build-plan.md`). **Boundary:** `billing` schema + the (deferred) rating boundary. **Depends on:** bm04 (stage ingest, Validation, detail page).
**Grounded in** (repo-relative): `db/schema/billing/{catalogs,accounts}.ts` (`bill_cycle.payment_due_days`, `billing_account.payment_due_days_override`), the existing **payment-term resolution** (`coalesce(account override, cycle default)`, `tests/accounts/v10-term-resolution.test.ts`), the billing-table + partman idioms from bm02–bm04. **`bill_format` has no schema table (deferred, rendering phase).**

> **Reshaped by the "no `rating` table in v1" decision.** There is no `rating.udr_rated` and no dummy rows, so bm05 has **no rating grant, no `rating-claim.ts`, no charge-line source**. The **Collection/Claim** stage is a **no-op** that records completion; **Aggregation** writes a trial `customer_bill` per account with a **deterministic synthetic stub total** (the figure is generated, not summed from data) so the stub-data UI shows realistic non-zero amounts.
>
> **Resolved:** v1 bill totals are a **deterministic synthetic stub** figure per account, generated in Aggregation (gated by stub-data mode) — **not** real charges (there is no `rating` table). The figure is **stable across reruns and tests** (no randomness — `Math.random` is banned anyway). When the rating engine lands, Aggregation reads real charges from `rating.udr_rated` instead.

---

## Goal

The **Aggregation** stage writes one trial `customer_bill` per validated, non-excluded account (with a resolved `payment_due_date`) into a new monthly-partitioned `billing.customer_bill` table, and the run-detail **Customers & Bills** tab lists every account's draft bill — while the **Collection/Claim** stage auto-completes as a no-op (no `rating` table in v1) and bill totals are a **deterministic synthetic stub** (stub-data mode) until the rating engine supplies real charges.

---

## Design

### Structural
- **New table `billing.customer_bill`** — monthly `pg_partman`-partitioned on `period_partition`. Columns (plan §6.3): `customer_bill_id` (`CBL…`), `ref_bill_run_id`, `ref_billing_account_id`, `period_partition` date, `category` (`BillCategory` CHECK `trial|normal|last`), `state` (`BillState` CHECK `new|validated|sent`, v1 writes `new`), `billing_period_start`/`billing_period_end` date, `subtotal`/`tax_total`/`total_amount` `numeric(18,2)`, `payment_due_date` date, `ref_bill_format_id` **text nullable, reserved — no FK** (catalog deferred), `ref_bill_template_version_id` **text nullable, reserved — no FK**, `ref_inv_document_id` text nullable (the **finalization latch**, set at posting/bm11), `posted_attempt` int nullable, `charge_checksum` text nullable. **Composite PK `(customer_bill_id, period_partition)`**, **UNIQUE `(ref_bill_run_id, ref_billing_account_id, period_partition)`**. Register with partman (extend the billing bootstrap). `BillCategory`/`BillState` unions in `types/billing.ts`.
- **Collection/Claim stage (stage 3) — v1 no-op.** The ingest's `collection` signal records the stage `DONE` and advances; **there is no `rating` table to claim from**, so there is **no rating grant, no `rating-claim.ts`, no cross-schema write**. A `// deferred: rating claim + grant land with the rating engine` marker documents where the claim goes later (architecture Inv. #2 unchanged — when rating exists, the single claim-marker `UPDATE` is added here).
- **Aggregation stage (stage 4)** `services/billing/aggregate-bill.ts`: for each **non-`EXCLUDED`** account that passed Validation, write one `customer_bill` — `category = 'trial'`, `state = 'new'`, `billing_period_start/end` from the run, `payment_due_date` = the invoice/run date (`scheduled_run_date`, the v1 `entry_date`) + the **resolved payment-term days** (existing `coalesce(account.payment_due_days_override, cycle.payment_due_days)` resolution). **v1 → a deterministic synthetic stub subtotal** per account — a **stable function of the `billing_account_id`** (e.g. a base amount plus a fixed offset derived from the BAN's numeric suffix; **no randomness**, so reruns and tests are stable), gated by stub-data mode; when the rating engine exists this becomes a SQL sum over `rating.udr_rated`. Money is `numeric(18,2)`/`string`, never JS float. Rerun-safe: the write is a **conditional DELETE+INSERT** keyed on `(run, ban)` guarded by `ref_inv_document_id IS NULL`, so bm08's rerun re-derives trial bills but never touches a posted one.
- **One synthetic stub line in v1.** The per-line expander shows a single synthetic **"Stub charges (fixture)"** line equal to the subtotal, so the non-zero total is explained; real itemized lines from `rating.udr_rated` (which does not exist yet) arrive with the rating engine. The `charge_checksum`/`posted_attempt` columns stay null until bm11.

### Visual (`billmgmt-ui-context.md`)
- **Customers & Bills tab** (fills the bm04 placeholder): `CustomerBillTable` — per account: name, `BillCategoryBadge` (`trial`/`normal`/`last`), subtotal/tax/total via the `lib/` currency formatter (tabular-nums), `payment_due_date`. A row expands to a charge-lines panel showing a single synthetic **"Stub charges (fixture)"** line equal to the subtotal (real itemized lines arrive with the rating engine). `StubDataBanner` continues to mark figures as fixtures.
- `EXCLUDED` accounts (bm03) do **not** appear here — they surface on Uncharged (bm07).

---

## Implementation

### 1. Schema — `db/schema/billing/customer-bill.ts` (+ migration + partman)
Drizzle typing (composite PK on the partition key), `CBL` id default + `customerBillSeq`, `BillCategory`/`BillState` CHECKs, the UNIQUE, FKs to `bill_run`/`billing_account` (none to format/template — reserved nullable). Export from `db/schema/index.ts`. Custom SQL migration (`PARTITION BY RANGE (period_partition)` + default partition). Extend `db/bootstrap/billing-partman-setup.sql` with the `customer_bill` registration (monthly, 7-year detach).

### 2. Types — `types/billing.ts`
`BillCategory = 'trial' | 'normal' | 'last'`; `BillState = 'new' | 'validated' | 'sent'`. Read model `CustomerBillRow` (account name, category, subtotal, tax, total, dueDate). Money fields are `string`.

### 3. Collection/Claim stage — `services/billing/collect-claim.ts`
A v1 no-op that returns `DONE` for the `collection` stage (records + advances via the bm04 ingest). Documents the deferred rating grant/claim; **writes nothing to any `rating.*` object** (none exists).

### 4. Aggregation service — `services/billing/aggregate-bill.ts`
`aggregateBill(tx, run, banId)` — resolve payment-term days, compute `payment_due_date`, `DELETE FROM customer_bill WHERE ref_bill_run_id = :run AND ref_billing_account_id = :ban AND ref_inv_document_id IS NULL` then `INSERT` the trial row with a **deterministic synthetic stub subtotal** (a stable function of `billing_account_id`, no randomness) in v1 — replaced by a SQL sum over `rating.udr_rated` when rating exists. Invoked by the ingest when the `aggregation` stage signal arrives (bm04 record-and-advance path). Framework-agnostic.

### 5. Customers & Bills tab — `app/(app)/billing/bill-runs/[runId]/` + `components/billing/`
Fill the tab placeholder: `customer-bill-table.tsx` (`CustomerBillTable`), `bill-category-badge.tsx` (`BillCategoryBadge`), a read service `services/billing/read/list-account-bills.ts` returning `CustomerBillRow[]`. The charge-lines expander renders the v1 "no rating source" note.

### 6. Tests — `tests/…`
- Aggregation writes exactly one trial `customer_bill` per validated non-excluded account, `state='new'`, `category='trial'`, `payment_due_date` = run date + resolved term days; **a deterministic synthetic stub total** that is stable across reruns (same account → same figure, no randomness).
- **Rerun-safety:** re-running aggregation for an account with `ref_inv_document_id IS NULL` re-derives the trial row; a row with `ref_inv_document_id` set is **never** deleted (guard holds — full test in bm08/bm11, asserted structurally here).
- Collection/Claim writes nothing to any `rating.*` object (there is none) and records `collection` `DONE`.
- `UNIQUE (run, ban, period_partition)` prevents a duplicate bill; partman partition present.
- Customers & Bills lists each account's draft with `BillCategoryBadge` + formatted totals; `EXCLUDED` accounts are absent; the charge-lines panel shows the deferred-rating note.
- Route × level for the tab (`billrun_view`).

---

## Dependencies (packages to install)

**None.** Reuses `drizzle-orm`/`zod`/`lucide-react`/`cva`; the currency formatter and payment-term resolution exist; pg_partman provisioned.

---

## Verification checklist

Schema
- [ ] Migration creates `billing.customer_bill` RANGE-partitioned on `period_partition`, composite PK, `UNIQUE (ref_bill_run_id, ref_billing_account_id, period_partition)`, `BillCategory`/`BillState` CHECKs, the reserved nullable `ref_bill_format_id`/`ref_bill_template_version_id` (no FK), and the nullable `ref_inv_document_id`/`posted_attempt`/`charge_checksum`; partman-registered; `db:migrate` + partman clean; typecheck/lint/format clean; no new dependency.

Draft bills (the visible result)
- [ ] After processing, each validated non-excluded account has one `trial` `customer_bill` with a resolved `payment_due_date` and (v1) a **deterministic synthetic stub total** (stable across reruns); the Customers & Bills tab lists them with `BillCategoryBadge` + formatted amounts.
- [ ] The Collection/Claim stage records `DONE` and writes to **no** `rating.*` object; there is no rating grant, `rating-claim.ts`, or cross-schema write in this unit.
- [ ] The charge-lines expander shows a single synthetic "Stub charges (fixture)" line equal to the subtotal (itemized lines arrive with the rating engine); `charge_checksum`/`posted_attempt` stay null.
- [ ] `EXCLUDED` accounts do not appear on Customers & Bills.

Rerun-safety (guard, exercised fully in bm08/bm11)
- [ ] Aggregation's write is a conditional `DELETE … WHERE ref_inv_document_id IS NULL` + `INSERT`; a bill carrying `ref_inv_document_id` is never deleted.

Discipline
- [ ] No posting, taxation, verification, or Uncharged/Errors logic here (bm06–07, bm11); docs updated same change set (`billmgmt-code-standards.md` §8 bm05 row + `billmgmt-progress-tracker.md`); the **synthetic-stub-total** approach recorded.
