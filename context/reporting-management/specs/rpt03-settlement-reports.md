# rpt03 — Settlement Reports (Part A): Invoice Report + Payment Report

**Unit:** rpt03. **Boundary:** RUNTIME (`runtime/reporting/settlement_invoice/`, `runtime/reporting/common/receivables.py`), FLOWS (`report-settlement-invoice`, two contracts), ROLE (one grant: `billing.pgledger_transfers_view`), TESTS (`tests/reporting/`, the settlement fixture).

**Specs from:** `_newmodule-reporting-plan.md` Part A (SR1–SR42, §A.1–§A.4, tests T1–T21), OI-5 and OI-6 current handling, MO18; `rptmgmt-architecture.md` Inv 2, 3, 5, 7, 8, 10; `rptmgmt-code-standards.md` §2, §3, §5–§7, §9.4–9.5; rpt01 (role, `common/db.py`, `common/trace.py`, WARNING contract); rpt02 (subflows, writer, contracts, codes).

**Depends on:** rpt02.

---

## Goal

`report-settlement-invoice` produces, for one billing period and a payment cut-off date, two CSVs from one consistent read:

- `Reporting_dnb_settlement_invoice_<ts>.csv`: one row per posted invoice, with how much is still open;
- `Reporting_dnb_settlement_invoice_payment_<ts>.csv`: every payment-side movement behind those numbers, plus account-level items and each MNO's unapplied cash.

`common/receivables.py` is built here and reused by rpt05 and rpt09.

---

## Design

### D1 — Signs come from the posted ledger legs (Q1, 2026-10-29)

`common/receivables.py` never decides a sign from a document or line type. For each posted `document_line`, it reads the transfer recorded on the line (`document_line.pgledger_transfer_id` → `billing.pgledger_transfers_view`: `from_account_id`, `to_account_id`, `amount`) and compares its accounts with the owner's ledger accounts (`billing.ledger_binding`):

| Effect | Rule |
|---|---|
| **Receivables effect** of a line on BAN *b* | `+amount` if `to_account_id` = *b*'s `receivables` account; `−amount` if `from_account_id` = it; `0` otherwise |
| **Unapplied-cash held** change on financial account *f* | `+amount` if `from_account_id` = *f*'s `unapplied_cash` account; `−amount` if `to_account_id` = it; `0` otherwise |

- pgledger moves value from `from` (decreases) to `to` (increases) (`leg-templates.ts`, ac08 note). Receivables is an asset, so "into receivables" means the MNO owes more. Unapplied cash is held as a negative balance, so "out of unapplied" means more cash held.
- **SR18's `payment_amount` = −(receivables effect).** Positive reduces what the MNO owes.
- This gets reversals (`postExplicitLegs`), refunds (`release` back into receivables, payout into unapplied), DBN tax lines and rounding in either direction right without a special case. The SR18 sign table in the plan stays as the **expected result**, asserted by tests (T5–T7), not coded.
- `receivables.py` exposes: `receivables_effects(snapshot, ban_ids, as_of)`, `unapplied_held(snapshot, fa_ids, as_of)`, and `open_amount(invoice, linked_effects)`. rpt05 and rpt09 reuse them.
- **Grant:** `SELECT` on `billing.pgledger_transfers_view` only. It's a plain view (migration `0011`), so the underlying table needs no grant. This is the pgledger grant rpt01 deferred here.

### D2 — Selection (SR1, SR2, SR5, SR6, OI-6 interim)

All reads happen in one `read_snapshot()` (rpt01, Inv 2).

- **Invoices:** `customer_bill` rows whose `billing_period_start` falls in `billing_period` and whose `ref_inv_document_id` is set, joined to the INV `document`. `invoice_id` = the INV `document_id`; `invoice_entry_date` = its `posted_at` as an Asia/Kuala_Lumpur day; `invoice_amount` = INV `total_amount`; `invoice_due_date` = `customer_bill.payment_due_date` (SR2–SR4).
- **MNO:** `billing_account.ref_party_role_id` → `customer.party_role.party_role_specification->>'mnoPublicKey1'`. The financial account is `billing_account.ref_financial_account_id`.
- **Payment-side documents counted:** `doc_type` in `PAY`, `CRN`, `DBN`, `ADJ`; `state` = `posted`, or `reversed` (the original of a reversal pair); `entry_date` ≤ `as_of_date` (SR6). `draft`, `pending_approval` and `cancelled` never count. `DEP` documents produce no payment row (they don't touch receivables) but do move unapplied cash (D4).
- **Invoice-linked rows (SR9a):** lines whose `ref_settled_document_id` is a reported invoice, and lines that reverse or release such a line (traced through `reversed_by_line_id` on the original line, SR17).
- **Account-level rows (SR12, OI-6 interim):** payment-side documents with a non-zero receivables effect on a reported BAN and no invoice link, whose `entry_date` is between the earliest invoice `posted_at` day in the report and `as_of_date`. The window is OI-6's interim rule; changing it is a decision, not a fix.

### D3 — Row grain and columns (SR9–SR17, §A.1)

- **One payment row per (document, `invoice_id`)**, the sum of that document's receivables effects for that invoice (blank `invoice_id` for account-level). A refund that releases two allocations gives two rows; a DBN's charge and tax lines give one row. A document whose total receivables effect is zero gives no row.
- `type_of_payment` (SR11): `REV` for any document with `reversal_of` set and for `release` lines of a `PAY` (a refund's release of an allocation); otherwise the `doc_type`. `UNAPPLIED` for the balance row.
- `payment_transaction_no` = the document's own id (the reversal's id for `REV`). `payment_reference` = `document.reference_info`. `cheque_realization_date` and `comment` are always blank (SR15, SR16).
- **`invoice_open_amount` = `invoice_amount − Σ payment_amount` of that invoice's invoice-linked rows** (SR19, SR20). Account-level and UNAPPLIED rows never reduce it.
- **Sorting** as §A.1: invoice report by `mno_id`, `invoice_id`; payment report by `mno_id`, then invoice-linked rows (by `invoice_id`, `payment_transaction_no`), then account-level rows (by `payment_transaction_no`), then the UNAPPLIED row.

### D4 — Unapplied cash (SR13, SR14)

- One `UNAPPLIED` row per MNO that has an invoice in the report: `payment_amount` = Σ over the MNO's financial accounts of `unapplied_held` for documents (any `doc_type`, including `DEP` release and refund payouts) with `entry_date` ≤ `as_of_date` and state `posted`/`reversed`. No row when it's zero.
- **SR14's method is fixed here:** computed from posted transfers by document `entry_date`, never read from the live balance, so a past `as_of_date` reproduces. T21 pins it: with `as_of_date` = today and no backdated documents after today, it equals `−balance` of the `unapplied_cash` account in `pgledger_accounts_view`, read by the test's own connection.

### D5 — Skips and failures (SR25–SR29)

- An invoice whose MNO has no `mnoPublicKey1` (`MNO_PUBLIC_KEY_MISSING`) or whose INV has no `posted_at` (`INVOICE_POSTED_AT_MISSING`) is dropped with all its payment rows; an MNO with no key also loses its account-level and UNAPPLIED rows. One `WARN SKIPPED <invoice_id> <reason>` line each; label `skipped_invoices=<n>`; status WARNING.
- Zero selected invoices: FAILED `NO_INVOICES_FOR_PERIOD <YYYYMM>`. Every selected invoice skipped: FAILED `ALL_INVOICES_EXCEPTED`.
- **Report check (SR19)** before the files are written: for each invoice, `invoice_amount − Σ invoice-linked payment_amount = invoice_open_amount`. A failure is FAILED `OUTPUT_CONTRACT_VIOLATION <file> <row> invoice_open_amount PER_INVOICE_CHECK`.

### D6 — Files and timestamp (SR22–SR24)

- `<ts>` = the execution's start (`{{ execution.startDate }}`) converted to Asia/Kuala_Lumpur and formatted `yyyyMMddHHmmss`, passed to the runtime as an argument so both files share it.
- Two contracts in `flows/reporting/contracts/`: `settlement_invoice.yaml` and `settlement_invoice_payment.yaml`, `header: true`, columns and types exactly as §A.1, each with its readers (Finance / billing ops) in a comment.
- Outputs only (SR24). No folder delivery for Part A.

### D7 — Runtime modules (SR36, SR37)

```
runtime/reporting/settlement_invoice/
├── __init__.py
├── extract.py         # the one read: invoices, MNO keys, bindings, documents, lines, transfers
├── exceptions.py      # SR27/SR28: drop rows, emit SKIPPED lines
├── payment_report.py  # SR9–SR17 rows, using common/receivables.py
├── invoice_report.py  # SR20 open amounts, SR19 check
└── __main__.py        # args, assembly, both files, trace + status
```

Run as `python3 -m runtime.reporting.settlement_invoice --billing-period … --as-of-date … --ts … --out-dir …`. Formatting and writing only through `common/csv_writer.py`; codes only from `common/codes.py`.

### D8 — Flow `report-settlement-invoice` (SR32, SR38, SR40)

- Inputs: `billing_period` (string, required), `as_of_date` (string, optional).
- Tasks:
  1. `validate_period`: `report-validate-period` (subflow) → `period_start`, `period_end`, `effective_as_of_date`;
  2. `generate`: the runtime, writing both files and emitting `skipped_invoices` and `status`;
  3. `validate_output_invoice` and `validate_output_payment`: `report-validate-output`, once per file;
  4. `publish`: both files as execution outputs, one `DELIVERED` line each (`common/trace.py`);
  5. `set_status`: WARNING when `status` = WARNING (rpt01 D8).
- Labels: `billing_period`, `as_of_date` (effective), `report=settlement_invoice`, `skipped_invoices`, `flow_revision`.

### D9 — Fixture and tests location

- Tests follow the codebase's rating pattern: **vitest integration tests in `tests/reporting/`** that seed a live database and run the runtime by absolute `python3` path, as `tests/helpers/rating-ran-harness.ts` does. rpt03 extends rpt01's `tests/helpers/reporting-harness.ts` with seeding and output reading, and adds the Part A seed `tests/fixtures/reporting/settlement-seed.ts`, which posts documents through the real Accounts services so the ledger transfers are real.
- Expected CSVs live in `tests/fixtures/reporting/settlement/expected/`. Comparison ignores only `<ts>` (§A.4).

### D10 — Codes added to the register

`NO_INVOICES_FOR_PERIOD`, `ALL_INVOICES_EXCEPTED`, `SKIPPED` reasons `MNO_PUBLIC_KEY_MISSING`, `INVOICE_POSTED_AT_MISSING`, and the violation reason `PER_INVOICE_CHECK` (in `codes.py` and code-standards §6 together).

---

## Implementation

1. **Role:** `reporting-db-roles.sql` gains `GRANT SELECT ON billing.pgledger_transfers_view`; R01-T2/T5 expectations grow by one object.
2. **Runtime:** `common/receivables.py` (D1); `settlement_invoice/` (D7); `codes.py` additions (D10).
3. **Flow and contracts:** `report-settlement-invoice.yaml`; `contracts/settlement_invoice.yaml`, `contracts/settlement_invoice_payment.yaml`.
4. **Tests:** harness, seed, expected CSVs, the suites below.
5. **README:** the report row in `flows/reporting/README.md`.

## Tests

The plan's T1–T21 (§A.4) are the acceptance set. All run against the seeded live database; the flow-level ones also on a local Kestra.

| # | Test | Expected |
|---|---|---|
| T1–T13 | §A.4 cases | as the plan, row for row against the expected CSVs |
| T14 | Per-invoice check | holds for every invoice; a deliberately corrupted open amount fails `PER_INVOICE_CHECK` |
| T15, T16 | Empty / all skipped | FAILED `NO_INVOICES_FOR_PERIOD 203001` / `ALL_INVOICES_EXCEPTED`; no outputs |
| T17 | Bad inputs | FAILED at `validate_period` (rpt02 subflow, run here end to end) |
| T18 | Output format | exact headers and order; two files sharing one `<ts>`; a `payment_reference` with a comma is quoted; label `skipped_invoices=0` on a clean run |
| T19 | Output check | already covered in rpt02; here: a corrupted generated file stops `publish` |
| T20 | Consistent read | a PAY posted from a second connection while `extract` runs appears in neither file, or consistently in both |
| T21 | Historical unapplied | `as_of_date` = today → UNAPPLIED equals `−balance` of `unapplied_cash` in `pgledger_accounts_view` |
| R03-T1 | Ledger signs | for every line in the seed, `receivables_effect` equals the sign the plan's SR18 table predicts, including a reversed allocation, a refund release, a DBN with tax, and rounding in both directions |
| R03-T2 | Reproducible | two runs with the same inputs produce identical files apart from `<ts>` |
| R03-T3 | One sign rule (guardrail 5) | no module outside `common/receivables.py` reads `from_account_id` / `to_account_id` or maps a `doc_type`/`line_kind` to a sign |
| R03-T4 | Time zone (guardrail 4) | an INV posted 23:59 and one at 00:01 Asia/Kuala_Lumpur get different `invoice_entry_date`s, under session time zones UTC and Asia/Kuala_Lumpur |
| R03-T5 | Grant | `reporting_runtime` can `SELECT` `pgledger_transfers_view` and still not `pgledger_accounts_view`, `pgledger_entries_view` or the base tables |

## Docs to sync in the same change set

- `rptmgmt-architecture.md` Inv 3: the sign comes from the posted transfer on each line, read in `common/receivables.py` (D1).
- `rptmgmt-code-standards.md`: §2.3 (signs only from `receivables.py`, which reads ledger legs), §6 (D10 codes), §7 (the pgledger row becomes `pgledger_transfers_view`, rpt03).
- `_newmodule-reporting-plan.md`: SR14 (method fixed, D4), SR18 (source is the posted leg; the table is the expected result).
- `rptmgmt-progress-tracker.md`, `specs/rpt00-build-plan.md` status.

## Verification checklist

1. T1–T21 and R03-T1–T5 pass against a live database; T17–T19 and the WARNING path on a local Kestra.
2. The sample files in `sample-files/` (T1–T8 illustration) are consistent with the fixture's expected CSVs, or the difference is explained in the PR.
3. Lint, type check and the rpt01/rpt02 suites still green.
4. Docs synced (above).
