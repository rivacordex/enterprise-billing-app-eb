# Accounts Module — Project Overview

**Module:** Accounts (Enterprise Billing) · **Source of truth:** `_plan_enterprise-billing-app/_newmodule-account-plan.md` (decisions Q1–Q28, all resolved) · **Users:** Revenue Operations (RevOps) team

## Overview

The Accounts module adds double-entry financial accounting to the Enterprise Billing solution. It manages each validated customer's Financial Account (`FIN…`, one per customer party role) and Billing Accounts (`BAN…`, per contract grouping), and lets RevOps perform every money operation the business needs before invoicing exists: advance payments, payment capture and manual allocation, credit notes (CRN), debit notes (DBN, the only charge vehicle in this phase), write-off and rounding adjustments, reversals, and the security-deposit lifecycle (capture, reverse-to-account, refund). Master data follows TMF666/TMFC024 (two concrete tables plus a `billing.account_view` UNION for the TMF base-Account shape); all money lives in a pgledger double-entry core forked into the `billing` Postgres schema; every operation is a workflow document (draft → pending_approval → posted → reversed) that posts atomically to the ledger; and a role-mapped Chart of Accounts produces a balanced monthly GL journal exported as CSV.

## Goals

1. Give every validated customer a correct financial structure automatically: FA + BAN + three ledger accounts (`receivables`, `unapplied_cash`, `deposits`) + bindings created in one transaction by the validation wizard (Q2), with bill cycle from the catalog (Q13) and negotiated payment terms (Q14).
2. Let RevOps execute every operation of the transaction vocabulary (Q17) through approval-gated documents (Q18/Q20), with zero direct ledger writes from the UI.
3. Keep balances live, never stored: A/R, unapplied cash, deposit held, and the overdue badge are always computed from `pgledger` views + terms (Q8/Q14).
4. Make every ringgit traceable: document → lines → transfers → entries → GL code, one unbroken chain (Ledger Explorer, GL Journal drill-down).
5. Close each accounting period safely: posting into a closed period is rejected with re-date (Q9); the exported journal always balances (Σ debit = Σ credit).
6. Ship a foundation the future Invoicing and bank-integration modules consume without migration (bill-cycle catalog, terms resolution, document layer, GL metadata escrow — Q21/Q25).

## Core user flow (start to finish)

1. A customer in the Customer module transitions to `VALIDATED`. The inline wizard opens: currency read-only (MYR, Q12), bill cycle picked from active `billing.bill_cycle` entries (default from Accounts Settings), credit limits, optional payment-terms override (e.g. net 45). Confirming commits status change + `FIN…` + `BAN…` + 3 pgledger accounts + 3 binding rows in one DB transaction.
2. RevOps opens **Accounts → Accounts Overview**, searches by Creditor/Debtor name, and selects the customer, financial account, and billing account. This selection persists as a context strip across Accounts Overview, Ledger Explorer, and Transactions (locked item 5).
3. RevOps captures the security deposit on the **Transactions** page: DEP document, reason `SEC_DEPOSIT`, payment mode `cheque` with cheque number in `mode_ref` (Q22). Amount is above the reason's `auto_post_limit` 0? No — `SEC_DEPOSIT` seeds at 50,000, so a USER posts it directly; `deposits → sys.cash` legs post atomically.
4. On cycle day 1, RevOps raises the monthly charge: DBN document, reason `MANUAL_CHARGE`, RM 5,000 + RM 400 tax → two transfers into `ban.{id}.receivables`. The BAN shows `due`; past due-date (bill date + resolved term) the UI derives **overdue** at read time.
5. The customer pays RM 5,400 by bank transfer. RevOps captures a PAY document (reason `CUST_PAYMENT`, mode `bank_transfer`, bank ref in `mode_ref`): line 1 `capture` books the money into `unapplied_cash`; line 2 `allocation` applies it to the BAN manually (Q24 — no auto-application). Partial allocation leaves the remainder unapplied (an advance payment is exactly a capture with no/partial allocation, Q15).
6. A mistake (e.g. wrong BAN allocated) is fixed in the **Reversals** workbench (Q5): pick the posted doc, preview opposite legs, reverse the single allocation line with a reason code — the bank capture stays untouched.
7. A goodwill credit above RM 1,000 (reason `GOODWILL_CREDIT`) goes to `pending_approval`; a MANAGER (≠ creator) approves, and the CRN posts against `sys.revenue_adj` (Q19/Q20).
8. At contract end, RevOps reverses the deposit to the account (`DEP_REVERSE`, always four-eyes), allocates it against final A/R, and refunds the remainder (`DEP_REFUND`). Account closure is only possible at zero balances (Q11).
9. At month end, a user with `accounts-config` closes the period; late postings are rejected with a re-date prompt (Q9). Finance opens **GL Journal**, verifies Σ debit = Σ credit, drills any GL code to its source entries, and exports the CSV journal (audited).

## Features by category

### Account management

- Validation wizard: atomic FA/BAN/ledger/binding creation, catalog-driven bill cycle, terms override (Q2/Q13/Q14)
- Returning customers see prior/closed accounts; explicit re-creation only, no silent duplicates (Q2)
- Zero-balance-gated closure with guided settle-first path (Q11)
- `billing.account_view` composes the TMF base-Account shape, including `relatedParty[]` from the `ref_party_role_id` FK (Q6/Q28)

### Transactions (documents)

- Doc types PAY / DEP / CRN / DBN / ADJ with per-type id prefixes; state machine draft → pending_approval → posted → reversed (Q18)
- Reason-code catalog with posting nature and per-code `auto_post_limit`; approver ≠ creator enforced server-side (Q19/Q20)
- Every document captures three mandatory fields (Q29): `event_at` (entry date — drives period/journal), `reference_date` (manual, defaults to today), and `reference_info` (e.g. transaction code)
- Payment modes `bank_transfer | cash | cheque` with mode-specific references; all manual, cheques assumed to clear (Q22/Q27)
- Split context requirements: CRN/DBN/ADJ need the selected BAN; PAY capture and DEP capture need only the FA; PAY allocation is a BAN-scoped document but the BAN is supplied by the form rather than required in the URL context (Q1)
- Document- and line-level reversal with conservation guarantees (Q5)
- Payment refund (`PAYMENT_REFUND`): bank payout of a customer overpayment / unapplied remainder, `sys.cash → unapplied_cash`, four-eyes (Q17/Q20)

### Ledger & GL

- pgledger fork in the `billing` schema with vendored upstream + transform script (Q10)
- Sys accounts per posting nature: `revenue`, `revenue_adj`, `write_off`, `rounding`, `tax_payable`, `cash` (Q19)
- Chart of Accounts mastered in-module (Q26); role/name mapping rules; unmapped-account health check
- GL Journal per period with drill-down, trial-balance toggle, CSV export; period close with reject + re-date (Q8/Q9)
- GL dimensions deferred via metadata escrow — `dim_*` keys promoted at ERP time, no re-posting (Q25)

### Pages & access

- Accounts (left nav): Accounts Overview, Ledger Explorer, Transactions, Chart of Accounts, GL Journal; Administration → Accounts Settings (reason codes, thresholds, bill-cycle catalog, defaults, flows documentation)
- Persistent selection context strip across Overview / Ledger Explorer / Transactions
- Three permissions on existing better-auth RBAC: `accounts-view`, `accounts-transactions`, `accounts-config` (Q7/Q20); server actions enforce independently of navigation

## In scope

- `billing.financial_account`, `billing.billing_account`, `billing.account_view`, `billing.bill_cycle`, `billing.reason_code`, `billing.document`, `billing.document_line`, `billing.ledger_binding`, `billing.gl_account`, `billing.gl_mapping`, `billing.accounting_period`, plus the forked pgledger tables/functions — all in the `billing` pg schema
- Validation wizard (FA/BAN auto-creation) and Customer-module touchpoints (Preferred PIC note, FA/BAN ids on the customer role section with deep links)
- All RevOps operations as documents, with approval workflow and thresholds
- Manual payment capture, allocation, and refund of overpayments (Q21/Q24)
- Security-deposit lifecycle: capture, reverse-to-account, refund, error correction via reversal (Q16)
- Period locking and close workflow; CSV GL journal export with audit events
- Live balances and read-time overdue derivation; MYR only operationally (Q12)
- Seeds: sys ledger accounts, CoA, GL mappings, reason codes, bill cycles

## Out of scope (deliberately deferred)

- Invoice/bill-run generation and TMF678 CustomerBill — DBN is the only charge vehicle; the stamped `payment_due_date` lands with the Invoicing module (Q8/Q14/Q21)
- Bank integration of any kind: no webhooks, no statement import, no auto-capture (Q21/Q22)
- Auto cash-application rules (oldest-first, remittance matching) — manual allocation only (Q24)
- Prepaid rating and wallet ledger role (Q23)
- Multi-currency operations and FX (model stays ready; Q12)
- Overdue scheduler / stored overdue flag; dunning notifications (Q8)
- ERP API integration and GL dimensions (CSV + metadata escrow instead; Q25)
- Cheque clearing lifecycle, post-dated cheques, bounce workflow — bounce = document reversal (Q27)
- Period reopening after close (Q9)

## Success criteria (definition of done)

1. All 14 verification steps in the plan's Part A §4 pass as automated tests, including: zero-sum invariant per currency, binding integrity (3 roles per customer), API/UI balance = ledger balance, cash-application conservation, GL resolution completeness (0 unmapped accounts), balanced journal (Σ debit = Σ credit), rollback atomicity, document state machine (threshold routing, approver ≠ creator, closed-period rejection), posting-nature steering (write-off lands in GL 6100), line-level reversal conservation, and the full deposit lifecycle ending at zero balances.
2. Validating a customer produces FA + BAN + 3 ledger accounts + 3 bindings in one transaction, and a forced mid-transaction failure leaves zero orphan rows.
3. Every operation in the RevOps vocabulary (Q17) is executable end-to-end on the Transactions page by a USER within limits and requires MANAGER approval above them; no ledger transfer exists without a posted document line pointing at it (1:1 `pgledger_transfer_id`).
4. The July sample scenario (Sample Telecom: DBN 5,400 → PAY 5,400 capture+allocation → deposit capture/reverse/refund) reproduces the plan's §2 tables exactly, and its GL journal export totals 16,200/16,200.
5. Closing a period blocks further postings into it with a re-date error (the user corrects the entry date into an open period); the exported CSV re-runs idempotently.
6. All five Accounts pages + Accounts Settings render with the three-permission RBAC enforced server-side; a user with only `accounts-view` can trace a transaction from Accounts Overview to its GL line without any write affordance visible.
