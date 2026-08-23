# bm09 — Accounts-side INV & posting enablement (cross-module) — Spec

**Unit:** bm09 (`bm00-build-plan.md`). **Boundary:** Accounts-owned `billing.document` / ledger objects (additive). **Cross-module — coordinate via the accounts plan; existing Accounts behavior stays byte-identical.** **Depends on:** the Accounts document engine + pgledger (exist). Land it **just before Approve (bm10)** — Approve's pre-approval checks are the first consumer (GL mappings + period-open).
**Grounded in** `F:/Projects/enterprise-billing-app/`: `db/schema/billing/documents.ts` (`document` + `doc_type` CHECK `('PAY','DEP','CRN','DBN','ADJ')`, per-type sequences), `services/accounts/post-document.ts` (`postDocument(tx, documentId, actorId)`, caller-txn, `auto_post_limit` gate, `periodKeyFor(eventAt)` period-open check, `resolveLegTemplate`), `db/schema/billing/catalogs.ts` (`reason_code`, `gl_mapping`), `db/seeds/accounts/{seed-reason-codes,seed-gl-mappings}.ts`, `db/schema/billing/periods.ts` (`accounting_period` PK `(period, currency)`), `services/accounts/period-close.ts` + `db/repositories/accounts/accounting-period.repository.ts`, `types/accounts.ts` (`DOC_TYPES`), `db/repositories/accounts/document.repository.ts` (`DOC_SEQUENCE_NAME`), `services/accounts/leg-templates.ts`, the CHECK-alter migration pattern (`0014`).

---

## Goal

Add an **`INV` invoice document type** end-to-end in the Accounts document engine — a `document_inv_seq`, `'INV'` in the `doc_type` CHECKs, a `STANDARD_INVOICE` reason code with an effectively-unlimited `auto_post_limit` (revenue nature), an `INV` leg template (A/R ← revenue + tax), and a **period-close guard** that refuses to close a period while a `bill_run` is still posting into it — so bm11 can auto-post one INV per billed account. Existing Accounts documents/flows are unchanged.

---

## Design

### Structural (all additive)
- **Doc type `INV`.** `types/accounts.ts`: `DOC_TYPES = [… , "INV"]`. `document.repository.ts`: `DOC_SEQUENCE_NAME.INV = "billing.document_inv_seq"`. Migration (new, e.g. `NNNN_add_inv_document_type.sql`): `CREATE SEQUENCE billing.document_inv_seq`; **drop+add** the `document_doc_type_check` and `reason_code_doc_type_check` to include `'INV'` (the `0014` alter idiom). `z.enum(DOC_TYPES)` (`validation/accounts/reason-code.schema.ts`) picks up `INV` automatically.
- **Reason code `STANDARD_INVOICE`** — seeded in `db/seeds/accounts/seed-reason-codes.ts` (idempotent pre-check): `{ reasonCode: 'STANDARD_INVOICE', docType: 'INV', postingNature: 'revenue', autoPostLimit: '999999999999.99' }`. The huge limit means `postDocument`'s `totalAmount > auto_post_limit` gate never trips ⇒ **INV auto-posts from `draft`** without routing to `pending_approval`; the **run-level four-eyes (bm10) is the sole second signature**, and each INV's `created_by` is the approver.
- **GL mappings — reuse existing** (no new rows): `ledger_role/receivables` → A/R, `system_account/sys.revenue.{ccy}` → revenue, `system_account/sys.tax_payable.{ccy}` → tax payable (all already seeded for the `DBN` revenue nature). bm09 **verifies** they resolve for INV; it adds none.
- **INV leg template** — `services/accounts/leg-templates.ts`: add `INV` templates so, per posted INV, the ledger records **debit A/R (receivables) = total**, **credit `sys.revenue.{ccy}` = net (subtotal)**, **credit `sys.tax_payable.{ccy}` = tax** — modeled on `DBN`'s revenue leg plus a tax leg. bm11 constructs the INV `document_line`s (a revenue `charge` line + the tax); this template maps them to pgledger legs via the existing `resolveLegTemplate(docType, lineKind)` path.
- **Period-close guard** — `db/repositories/billing/bill-run.repository.ts` gains `findActiveForPeriod(tx, period, currency)`: `bill_run` joined to its `customer_bill`s (for currency) where `to_char(gl_event_at, 'YYYY-MM') = period`, the bill currency = `currency`, and `status NOT IN ('COMPLETED','CANCELLED')`. In `services/accounts/period-close.ts`'s `closePeriod`, **before** `accountingPeriodRepository.close`, call it; if any active run maps to `(period, currency)`, return `{ ok: false, code: 'BILL_RUN_IN_PROGRESS', activeRunIds }`. (A run maps to the period of its `gl_event_at`, currency via its bills — single-currency per cycle in v1.)

### Cross-module discipline
- **Additive only** — no existing `document`/`reason_code`/`gl_mapping` row changes; the two CHECK constraints only *gain* `'INV'`. A guardrail test proves every existing Accounts document type, posting, URL, and authz result is unchanged.

---

## Implementation

### 1. Migration — `db/migrations/NNNN_add_inv_document_type.sql`
`CREATE SEQUENCE billing.document_inv_seq …`; `ALTER TABLE billing.document DROP CONSTRAINT document_doc_type_check, ADD CONSTRAINT … CHECK (doc_type IN ('PAY','DEP','CRN','DBN','ADJ','INV'))`; same for `billing.reason_code`.

### 2. TS + repository + leg template
`types/accounts.ts` (`DOC_TYPES += 'INV'`); `document.repository.ts` (`DOC_SEQUENCE_NAME.INV`); `services/accounts/leg-templates.ts` (`INV` A/R←revenue+tax legs).

### 3. Seeds
`db/seeds/accounts/seed-reason-codes.ts` — add `STANDARD_INVOICE`. `seed-gl-mappings.ts` — no change (verify revenue/tax mappings present).

### 4. Period-close guard
`bill-run.repository.ts` `findActiveForPeriod`; `services/accounts/period-close.ts` guard + a new `ClosePeriodResult` code `BILL_RUN_IN_PROGRESS` (surfaced in the accounts UI as "N bill run(s) still posting into {period}").

### 5. Tests — `tests/…`
- An `INV` document created with `STANDARD_INVOICE` **auto-posts** through `postDocument` (never `pending_approval`); legs = A/R debit + revenue credit + tax credit resolve via existing mappings; `event_at` drives the period.
- **[CRITICAL] Existing Accounts unchanged** — every current doc type still posts; the CHECKs only added `'INV'`; existing period-close still works.
- **Period-close guard** — closing `(period, currency)` is blocked (`BILL_RUN_IN_PROGRESS`) while a run with `gl_event_at` in that period is `< COMPLETED`; allowed once the run is `COMPLETED`/`CANCELLED`.
- `DOC_TYPES`/Zod accept `INV`; `document_inv_seq` yields `INV00000001…`.

---

## Dependencies (packages to install)

**None.** All additive to existing schema/services; pgledger + the document engine exist.

---

## Verification checklist

- [ ] Migration adds `document_inv_seq` and `'INV'` to both `doc_type` CHECKs (drop+add); `db:migrate` clean; `DOC_TYPES` + Zod accept `INV`; typecheck/lint/format clean; no new dependency.
- [ ] `STANDARD_INVOICE` reason code seeded (idempotent), `postingNature='revenue'`, `auto_post_limit` effectively unlimited ⇒ INV **auto-posts** from `draft`.
- [ ] The `INV` leg template posts A/R debit + revenue credit + tax credit via the existing GL mappings (no new mappings).
- [ ] The period-close guard blocks closing `(period, currency)` while a `bill_run` with `gl_event_at` in that period is not `COMPLETED`/`CANCELLED`; allows it otherwise; surfaced in the accounts UI.
- [ ] **[CRITICAL]** Every existing Accounts document type, posting, and period-close behavior is byte-identical (guardrail test); this unit is additive only.
- [ ] Coordinated via the accounts plan; docs updated same change set (`billmgmt-code-standards.md` §8 bm09 row + `billmgmt-progress-tracker.md`).
