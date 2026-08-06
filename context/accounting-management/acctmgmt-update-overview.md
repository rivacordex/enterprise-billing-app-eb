# Accounts Module — Transactions Update Overview

**Module:** Accounts (Enterprise Billing) · **Scope:** `/accounts/transactions` + Accounts nav · **Source of truth:** `_plan_enterprise-billing-app/_updatemodule-accounts-transactions-plan.md` (decisions D1–D7, all resolved 2026-08-06) · **Design artifact:** `mockup-accounts-transactions.html` · **Users:** Revenue Operations (RevOps) team

## Overview

This update restructures the shipped Transactions page from a vertical stack of twelve always-open action forms into a document workbench. Today `app/(app)/accounts/transactions/page.tsx` renders `CapturePaymentPanel`, `AllocatePaymentPanel`, `PaymentRefundPanel`, `CaptureDepositPanel`, `ReverseDepositPanel`, `RefundDepositPanel`, `RaiseDebitNotePanel`, `RaiseCreditNotePanel`, `WriteOffPanel`, `RoundingAdjustmentPanel`, `ReversalsPanel`, `ClosurePanel` and `PendingApprovalsList` simultaneously on every load, and shows no history of transactions performed — the page can create documents but cannot list them. The update moves the create-forms behind two primary buttons (**+ Payment**, **+ Note**) and a **More actions** menu, adds a filterable table of documents for the selected context, turns reversal from a free-typed document ID into a row-level action on documents that are actually reversible, opens a per-document detail drawer, moves Transactions to second position in the Accounts nav, and fixes sidebar links that currently discard the customer context. No posting logic, ledger legs, approval thresholds, reason-code behaviour, or `services/accounts/*` write path changes: every form component keeps its fields, validation and server action, and only its shell (bare `<section>` → `Dialog`) is replaced.

## Goals

1. Make the operator's current position legible before they act: show the documents already raised against the selected context, instead of an action list with no history.
2. Reduce the page from thirteen simultaneously-rendered panels to a header, an action bar of three controls, and one table — so reaching "Capture Payment" no longer requires scrolling past Reverse Deposit, Write Off and Rounding Adjustment.
3. Make reversal usable without prior knowledge: replace the free-text `docId` input in `ReversalsPanel` with a control on the document being reversed, shown only where `reverseDocument` would actually succeed.
4. Expose line-level reversal, which `reverseLine` already supports but no UI leads to — specifically reversing a payment's allocation line to return funds to unapplied cash while leaving the bank capture posted.
5. Surface the partially-reversed state, which is currently invisible: a document whose lines are partly reversed stays `posted` and remains actionable on its remainder.
6. Promote the approval queue from the bottom of the page to a banner and a table filter, so pending documents are visible on arrival rather than after twelve panels of scrolling.
7. Group the Accounts nav by workflow — context-establishing, context-consuming, context-optional, global — and stop the sidebar from dropping `?party&fa&ban` on navigation.
8. Add the read surface the module lacks (a document list query) without touching any write path.

## Core user flow (start to finish)

1. RevOps opens **Accounts → Accounts Overview**, searches by creditor/debtor name, and selects customer, Financial Account and Billing Account. The selection is held in the URL as `?party&fa&ban`.
2. They click **Transactions** in the sidebar — now the second item, directly beneath Overview. The link carries the context params, so the page opens with the context strip populated rather than reading "No selection".
3. The page loads scoped to the selection. A scope strip states which BAN is shown; an amber banner reports documents awaiting approval; four chips show unapplied cash, pending-approval count, open A/R and last activity.
4. The documents table lists every document matching `ref_financial_account_id = :fa AND (ref_billing_account_id = :ban OR ref_billing_account_id IS NULL)`, newest first, with doc ID, type chip (`PAY`/`DEP`/`CRN`/`DBN`/`ADJ`), scope marker (`BAN000001` or `FA-level · no BAN`), reason code, amount, state badge and created-by/date. Filters: type, status, reversibility, free text.
5. To record a receipt, RevOps clicks **+ Payment → Capture Payment**. The existing `CapturePaymentPanel` opens in a dialog with its fields unchanged (reason, amount, payment mode with mode-specific reference, entry date, reference date, reference info). On success the dialog closes and the table refreshes with the new `PAY` document — which appears as **FA-level** because `capture-payment.ts` writes `refBillingAccountId: null`.
6. To apply that cash, they click **+ Payment → Allocate Payment**. The allocation posts as its own `PAY` document scoped to the BAN, and appears as a separate row.
7. To review an approval, they click **Review now →** in the banner, which sets the status filter to `pending_approval`. Clicking the row opens the detail drawer showing amounts, reason, scope, lines, posting preview and the approval timeline, with **Approve & post** / **Reject…** in the footer. Approver ≠ creator remains enforced server-side.
8. To correct a mistake, they find the posted document and click **↺ Reverse** on its row — the control renders only where the document is `posted` with at least one line whose `reversedByLineId` is null. The dialog opens bound to that document, listing its unreversed lines with checkboxes, all checked.
9. Leaving every line checked calls `reverseDocument()` and the original flips to `reversed`. Unchecking some calls `reverseLine()`, the original stays `posted`, and the remaining lines can still be reversed later. The dialog shows the resulting legs (from ↔ to swapped) and warns when the reversal inherits an approval requirement from the original's reason code.
10. Documents that cannot be reversed show no reversal control at all. Their state badge (`Draft`, `Pending approval`, `Reversed`) explains why; the drawer adds one line of text naming the reversing document or pointing to approve/reject.
11. Switching to a different Billing Account is done in Overview, not here — the scope strip links back with context preserved. The page has one context selector, never two.

## Features by category

### Documents workbench

- Filterable, sortable table of `PAY` / `DEP` / `CRN` / `DBN` / `ADJ` documents for the selected context, newest first
- Scope predicate admits FA-level documents (`ref_billing_account_id IS NULL`) alongside the selected BAN, so payment captures and deposits are not hidden
- Per-row scope marker distinguishing BAN-level from FA-level documents
- Filters: doc type, document state, reversibility (all / reversible / partially reversed), free text over doc ID and reason code
- Reuses the existing `DocStateBadge` for all five states; adds a "Partially reversed" badge for posted documents with some lines reversed
- Empty state links back to Overview with context preserved

### Action launcher

- **+ Payment** (primary): Capture Payment · Allocate Payment · Payment Refund
- **+ Note** (primary): Raise Credit Note · Raise Debit Note
- **More actions** (secondary): Capture Security Deposit · Reverse Deposit to Account · Refund Deposit · Write Off · Rounding Adjustment
- Every entry opens its existing panel component unmodified inside a `Dialog`; no field, validation rule or server action changes
- "Reverse Deposit to Account" stays in this menu and is labelled as applying a deposit to A/R — it creates a new `DEP` document and is not a ledger reversal

### Reversal

- Row-level control, rendered only when `state === "posted"` and at least one line has `reversedByLineId === null`
- Hidden entirely on non-reversible documents; no permanently-disabled control on draft, pending or reversed rows
- Dialog bound to a specific document; the free-text `docId` input is retired
- Line checkboxes select between `reverseDocument()` (all unreversed lines) and `reverseLine()` (a subset), with the active call and its consequence stated in the dialog
- Reversal legs previewed before submission; inherited approval requirement stated before submission
- No permission distinction between document- and line-level reversal (both require `accounts-transactions` EDIT)

### Detail drawer

- Opens on row click: account, scope, reason code, amount, date, created-by, and reversal cross-links (`Reverses` / `Reversed by`)
- Document lines with per-line reversed state
- Posted ledger legs for unreversed lines
- Approval timeline plus Approve & post / Reject for `pending_approval` documents
- Reversal entry point for reversible documents; explanatory line instead of a control for the rest

### Navigation

- Accounts nav order becomes Overview → **Transactions** → Ledger Explorer → Chart of Accounts → GL Journal, ordered context-establishing → context-consuming → context-optional → global
- Single "Accounts" caption retained; no second section header
- All five Accounts nav links carry `?party&fa&ban`, including Chart of Accounts and GL Journal, which ignore the params but no longer discard the selection on a round trip

## In scope

- `app/(app)/accounts/transactions/page.tsx` — restructured from a panel stack to a workbench
- `components/admin-nav.tsx` — Accounts item order, and `href` construction reading current `searchParams` via `useSearchParams`
- New: a documents table component, a document detail drawer, and a document-bound reversal dialog
- Dialog shells around the ten create-panels; their internals unchanged
- `components/accounts/reversals-panel.tsx` — free-text `docId` form removed once the table exists (Phase 3)
- `components/accounts/pending-approvals-list.tsx` — absorbed into the table as a status filter; approve action preserved
- New read query on `db/repositories/accounts/document.repository.ts` (filters: type, state, date range, free text; with pagination), following the shape `listTransfersForAccount` uses in `services/accounts/ledger-explorer.ts`
- New `services/accounts/list-transaction-documents.ts` wrapping it, called from the page as `listPendingApprovals` is today
- Per-document line read for the reversal dialog, via the existing `documentLineRepository.findByDocumentId`
- Four phases: Phase 0 nav reorder + context preservation · Phase 1 dialog shells · Phase 2 documents table · Phase 3 row-level reversal + drawer

## Out of scope (deliberately deferred)

- **Account closure UI** — `ClosurePanel` continues to render exactly as it does today; relocating a terminal lifecycle action out of the routine-transaction set is a separate change (D1)
- **A `Tabs` primitive in `components/ui/`** — no longer required once Account Lifecycle is deferred; the page is single-scroll
- Any change to posting logic, ledger legs, document state machine, approval thresholds, reason-code catalog, or period-close behaviour
- Any change to the ten action services (`capture-payment.ts`, `allocate-payment.ts`, `refund-payment.ts`, `capture-deposit.ts`, `reverse-deposit.ts`, `refund-deposit.ts`, `raise-credit-note.ts`, `raise-debit-note.ts`, `write-off.ts`, `rounding-adjustment.ts`) or to `reverse-document.ts` / `reverse-line.ts`
- Any change to `document.repository.ts` write paths, `post-document.ts`, or `document-state-machine.ts`
- New document types — the five (`PAY`, `DEP`, `CRN`, `DBN`, `ADJ`) are unchanged; sub-actions remain distinguished by reason code
- New permissions — `accounts-view` / `accounts-transactions` / `accounts-config` unchanged, including no manager-only gate on line-level reversal (D5)
- FA-wide activity views across multiple BANs — that view remains in Accounts Overview and Ledger Explorer
- Accounts Overview, Ledger Explorer, Chart of Accounts and GL Journal page content (only their nav entries and context params are touched)
- Bulk actions on table rows; saved filter views; CSV export of the documents table

## Success criteria (definition of done)

1. `/accounts/transactions` renders a header, context strip, scope strip, banner/chips, an action bar of three controls, and one documents table. No create-form is visible until its dialog is opened.
2. Navigating Overview → Transactions via the sidebar preserves `?party&fa&ban`: the context strip is populated and the table is scoped, with no return trip to Overview required. The same holds for all five Accounts nav links, verified including Chart of Accounts and GL Journal.
3. Transactions is the second item in the Accounts nav section, under a single "Accounts" caption.
4. A payment captured through the dialog appears in the table without a manual refresh, marked **FA-level**, proving the scope predicate admits `ref_billing_account_id IS NULL`. A regression test asserts a `PAY` capture and a `DEP` capture are both returned when a BAN is selected.
5. Documents belonging to a different BAN under the same FA do not appear in the table.
6. The reversal control appears on exactly those documents where `state === "posted"` and at least one line has `reversedByLineId === null`, and on no others. A test asserts one case per branch: posted, partially reversed, `draft`, `pending_approval`, and fully `reversed`.
7. Reversing with all lines selected calls `reverseDocument` and flips the original to `reversed`; reversing with a subset calls `reverseLine`, leaves the original `posted`, and permits a later reversal of the remainder. Both paths are covered by tests asserting the resulting document state and line stamping.
8. A payment's allocation line can be reversed from the UI while its capture line stays posted, and the reversed amount returns to `unapplied_cash`.
9. A posted document with some lines reversed displays the "Partially reversed" badge alongside `posted`, and is reachable via the reversibility filter.
10. `ReversalsPanel`'s free-text `docId` input no longer exists; every reversal is launched from a document.
11. The approval banner is visible on page load when documents await approval, and its action sets the table's status filter to `pending_approval`. Approving from the drawer still rejects self-approval server-side.
12. Server-side behaviour is unchanged: `reverseDocument` and `reverseLine` still return `DOC_STATE_INVALID`, `ALREADY_REVERSED`, `WRONG_FINANCIAL_ACCOUNT`, `CONFLICT` and `PERIOD_CLOSED` under the same conditions as before this update, verified by the existing tests passing without modification.
13. `tests/accounts/route-level-transactions.test.ts` passes, along with `npm run typecheck` and `npm run lint`.
14. A user holding only `accounts-transactions` READ sees the table and drawer with no create, approve or reverse affordance rendered.
