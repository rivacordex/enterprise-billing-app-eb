# Accounting Management Module — Code Standards

This document extends the platform-wide `context/code-standards.md` — every rule there applies unchanged and is not restated; below are **only** the Accounting Management module's additions and deltas, derived from `acctmgmt-architecture.md` (module design) and `acctmgmt-project-overview.md`, with decision references (Q…) to `_newmodule-account-plan.md`. Where anything below conflicts with the platform Invariants or the module invariants in `acctmgmt-architecture.md` §6, the invariants win.

**Module baseline:** all tables in the **`billing`** pg schema (confirmed 2026-07-24 — no `accounting` schema exists) · pgledger fork for double entry (Q10) · users = RevOps · permissions `accounts_view` / `accounts_transactions` / `accounts_config`.

---

## 1. General Rules — module additions

1. **Money moves only through posted documents** (module inv. #3). The only code path that calls `pgledger_create_transfer(s)` is the document-posting use case in `services/accounts/post-document.ts`, called by document actions. Any other call site is a review-blocking defect.
2. **One transaction per financial mutation.** Document state change + all ledger transfers + `core.AUDIT_LOG` insert commit together (module inv. #5). No partial-post recovery code — a failure rolls back everything.
3. **Nothing in the `billing` schema is ever hard-deleted.** Platform §1.9's "tombstone where the spec says" translates here to: catalogs (`bill_cycle`, `reason_code`, `gl_account`) transition to `retired`; accounts transition to `closed` (zero-balance gated, Q11); documents transition to `reversed` or `cancelled` (draft only). There is no DELETE repository function for any module table.
4. **Approver ≠ creator is a service-layer check** (Q20, module inv. #6) on every approval, in addition to the permission check. UI hiding the approve button for the creator is UX only.
5. **Balances are never stored, cached, or passed as trusted input.** Every balance shown or compared (closure gates, credit utilisation, overdue badge) is read from `pgledger_accounts_view` inside the same service call that uses it (module inv. #2). A balance arriving in an action payload is display data — never used for a decision.
6. **Seeds are gated like code.** The seed set (sys ledger accounts per Q19 nature, CoA, GL mappings, reason codes, bill cycles) must leave the GL health check at zero unmapped accounts (V5); the seed integration test asserts it.

---

## 2. TypeScript Conventions — module additions

1. **Domain unions** (platform §2.6 style), defined once in `types/accounts.ts`:

   ```ts
   export const DOC_TYPES = ["PAY", "DEP", "CRN", "DBN", "ADJ"] as const;
   export const DOC_STATES = [
     "draft",
     "pending_approval",
     "posted",
     "reversed",
     "cancelled",
   ] as const;
   export const LINE_KINDS = [
     "capture",
     "allocation",
     "charge",
     "release",
     "refund",
   ] as const;
   export const LEDGER_ROLES = [
     "receivables",
     "unapplied_cash",
     "deposits",
   ] as const;
   export const POSTING_NATURES = [
     "revenue",
     "revenue_adj",
     "write_off",
     "rounding",
     "cash",
     "deposit_movement",
   ] as const;
   export const PAYMENT_MODES = ["bank_transfer", "cash", "cheque"] as const;
   export const ACCOUNT_STATES = ["active", "suspended", "closed"] as const;
   export const PAYMENT_STATUSES = ["paid", "due", "in_dispute"] as const; // overdue is derived, never stored (Q8)
   ```

2. **Money arithmetic lives in exactly one file: `services/accounts/money.ts`.** Platform §2.15/§6.16 require a design decision before money arithmetic — this is it: amounts stay `string` end-to-end; `money.ts` converts to integer **sen** (minor units) for add/subtract/compare, returns `string`, and throws `AppError('MONEY_PRECISION')` on >2 decimal places. No `parseFloat`, no `Number()` on an amount anywhere else, including tests.
3. **Signed-balance convention is encapsulated.** pgledger balances are signed (negative = credit). Only `money.ts` and the ledger repository interpret sign; UI and services consume named helpers (`isHeldLiability(balance)`, `openReceivable(balance)`) — never a raw `< 0` comparison on a balance string in a component.
4. **Module services return `Result`, never throw.** No `services/accounts/**` file constructs or throws an `AppError` — the module's failure vocabulary is the `{ ok: false, code }` catalog in **§9**, which is distinct from the platform's thrown `APP_ERROR_CODES` (`lib/errors.ts`). The two never mix: a Result code is never mapped to HTTP directly, and `AppError` never crosses a service boundary. Codes are stable machine strings; adding one is a documented change to §9, not an ad-hoc string.
5. **Optimistic-lock scope** (platform §6.19): the `billing.document` row on every state transition, via `last_modified`; concurrent approve/post races resolve to one winner and a `CONFLICT` result for the loser. Catalog edits (`reason_code`, `gl_account`, `gl_mapping`, `bill_cycle`) lock the same way.
6. **TMF composition types live in `types/accounts.ts`** (`TmfAccountRef`, `TmfRelatedParty`) and are produced only by the `account_view` repository mapper (Q28) — no page assembles TMF shapes ad hoc.

---

## 3. Next.js Rules — module additions

1. **The selection context strip is URL state.** `?party=PTRL…&fa=FIN…&ban=BAN…` on `/accounts/overview`, `/accounts/ledger`, `/accounts/transactions` (locked item 5). Never React context, never `localStorage`, never a cookie — a pasted URL reproduces the exact working context. A shared `parseAccountsContext(searchParams)` helper in `validation/accounts/` is the only parser.
2. **All Accounts pages are `force-dynamic`.** Balances are live reads (module inv. #2); no `revalidate`, no fetch caching on any `(app)/accounts/**` or accounts-settings page.
3. **Transaction actions are per-operation, not generic.** One Server Action per operation (`capture-payment.action.ts`, `refund-payment.action.ts`, `raise-debit-note.action.ts`, `reverse-document.action.ts`, …) so each declares its own Zod schema and permission level — no single `postDocument(anything)` action switching on `doc_type`. Each operation's Zod schema merges a shared `documentBaseSchema` making `event_at` (entry date), `reference_date`, and `reference_info` mandatory on every document (Q29); dates are captured date-only in the UI, defaulting to today (stored `timestamptz`).
4. **The validation wizard is Customer-module UI calling an Accounts service.** `app/(app)/customers/**` renders the Q2 wizard; the atomic FA/BAN/ledger/binding creation is `services/accounts/onboard-customer-accounts.ts`. The Customer module never touches `billing.*` repositories directly.
5. **Transactions greyed-out state comes from the context strip** (locked item 5): actions render disabled until the required context (FA always; BAN additionally for CRN/DBN/ADJ, Q1) is present in the URL — and the action re-validates the same requirement server-side.

---

## 4. Styling — module additions

1. **One shared component per money surface** (platform §4.8), in `components/accounts/`:
   - `amount-cell.tsx` — right-aligned, `tabular-nums`, always 2 dp, negative rendered in parentheses `(1,234.56)`, currency code from the row, never hard-coded `RM`.
   - `doc-state-badge.tsx` — one variant per `DOC_STATES` value, **plus a derived `partiallyReversed: boolean` prop** rendered beside the `posted` badge (D4); like `payment-status-badge.tsx` below, the component never computes the derived flag and partially-reversed never becomes a sixth `DOC_STATES` member.
   - `payment-status-badge.tsx` — renders stored status **plus** the derived overdue flag passed as a prop (`derivedOverdue: boolean`); the component never computes overdue.
   - `balance-check-strip.tsx` — the Ledger Explorer zero-sum indicator (V1): green `Σ = 0`, `bg-destructive` otherwise.
   - `context-strip.tsx` — the persistent party/FA/BAN selection header.
2. **Debit/credit and reversal colouring uses semantic tokens only**: `text-destructive` for reversals and imbalance states, `text-muted-foreground` for zero/derived values. No red/green literal palette classes (platform §4.3).
3. **Ledger and journal tables are dense**: `text-sm`, sticky header, server pagination (platform pattern); entries/journal rows never client-side-sort silently — sort is a URL param so exports match what is on screen.

---

## 5. API Routes — module additions

1. **v1 ships exactly one new Route Handler:** `POST /api/accounts/gl-journal-export` — body `{ period: 'YYYY-MM', currency: 'MYR' }` (Zod-validated), permission `accounts_config : EDIT`, streams `text/csv`, and writes the export audit event (period, row count, totals) in the same request. It is `POST`, not `GET`, precisely because it audits (platform §5.9 keeps `GET` side-effect-free).
2. **Everything else goes through Server Actions.** No TMF666 OpenAPI surface in this phase; when it comes, it is a separate adapter over `services/accounts/` + `account_view` (platform architecture §1), not new handlers in this app.
3. **CSV format is fixed and versioned in code**: header row `gl_code,gl_name,debit,credit`, UTF-8, CRLF, amounts plain `1234.56` (no thousands separators) — defined once in `services/accounts/journal-csv.ts`.

---

## 6. Data and Storage Rules — module additions

1. **Schema placement:** every module table, view, and the entire pgledger fork lives in **`billing`** (Q10; decision 2026-07-24). Cross-schema FKs to `core.APPUSER` (provenance) and to the Customer module's `party_role` (Q28) only.
2. **ID prefix registry** (platform §6.18) — one sequence per table, assembled in the DB layer:

   | Prefix                                | Table                           | Pad |
   | ------------------------------------- | ------------------------------- | --- |
   | `FIN`                                 | `financial_account`             | 6   |
   | `BAN`                                 | `billing_account`               | 6   |
   | `BCY`                                 | `bill_cycle`                    | 6   |
   | `LBD`                                 | `ledger_binding`                | 6   |
   | `GLM`                                 | `gl_mapping`                    | 6   |
   | `DLN`                                 | `document_line`                 | 8   |
   | `PAY` / `DEP` / `CRN` / `DBN` / `ADJ` | `document` (per-type sequences) | 8   |

   `reason_code` and `gl_account.gl_code` are natural keys (no prefix). pgledger keeps its own `pgla_`/`pglt_` ULIDs — never re-generated or parsed by app code.

3. **pgledger access rules:** repositories in `db/repositories/accounts/` are the only callers; **functions and views only** — `SELECT` from `pgledger_accounts_view` / `pgledger_transfers_view` / `pgledger_entries_view`, execute `pgledger_create_account` / `pgledger_create_transfer(s)`. Direct DML or `SELECT` on the underlying `pgledger_*` tables is a review-blocking defect (module inv. #4).
4. **Fork migration discipline** (Q10, module inv. #14): `db/pgledger/` holds the pristine upstream `pgledger.sql`, `UPSTREAM_COMMIT` file, and `transform.ts`; the raw-SQL migration is generated output, committed but never hand-edited. Upgrading = replace upstream file → re-run transform → review diff → new migration.
5. **JSONB columns are shape-guarded** (platform §6.17):
   - `contact` (FA/BAN) — strict schema: `{ refContactMedium: CTMD-id, contactType: 'billing' | 'finance', name }[]`.
   - `document.mode_ref` — **discriminated union on the sibling `payment_mode` column**: `bank_transfer → { bankRef }`, `cheque → { chequeNo, bank }`, `cash → { receiptNo }` (Q22).
   - `document.metadata` — **documented exemption**: validated for well-formed JSON plus reserved-key typing only (`doc`, `dim_*` reserved for Q25 escrow; unknown keys pass through). Accepted risk: free-form operator references; authorized by the platform JSONB exemption clause.
6. **Monetary columns** are `numeric(18,2)`; `currency` is `char(3)` and must be equal across FA ↔ BAN ↔ binding ↔ pgledger account (module inv. #9) — asserted by the binding integration test (V2), not by a cross-schema constraint.
7. **Every posted `document_line` ↔ one transfer:** `pgledger_transfer_id` is `UNIQUE NOT NULL`-on-post; transfer `metadata.doc` carries the `document_id` back (module inv. #3). The tracing join is always line → transfer id, never a metadata text search.
8. **Period validation is part of the posting repository transaction** (Q9): the `accounting_period` check on `event_at` runs inside the same transaction as the transfers, so a close racing a post cannot interleave.

---

## 7. File Organization — module additions

```
app/(app)/accounts/
  overview/page.tsx            # Accounts Overview (search + FA detail + BAN detail)
  ledger/page.tsx              # Ledger Explorer
  transactions/page.tsx        # Transactions workbench (PAY/DEP/CRN/DBN/ADJ + reversals)
  chart-of-accounts/page.tsx
  gl-journal/page.tsx
app/(app)/administration/accounts-settings/page.tsx
app/api/accounts/gl-journal-export/route.ts
actions/accounts/              # one action per operation (§3.3)
components/accounts/           # amount-cell, badges, context-strip, balance-check-strip (§4.1)
validation/accounts/           # per-operation schemas; parseAccountsContext; mode_ref discriminated union
services/accounts/             # post-document, onboard-customer-accounts, term-resolution, period-close,
                               # closure-gates, journal-csv, money
db/schema/billing/             # 11 tables + account_view/gl_resolution_view/gl_journal_view definitions
db/pgledger/                   # upstream pgledger.sql, UPSTREAM_COMMIT, transform.ts, generated SQL
db/repositories/accounts/      # only pgledger + billing.* callers
db/seeds/accounts/             # sys accounts, CoA, mappings, reason codes, bill cycles
tests/accounts/                # V1–V14 verification tests (see below) + route × level matrix
```

1. **Verification tests are named for the plan:** `tests/accounts/v01-zero-sum.integration.test.ts` … `v14-deposit-lifecycle.integration.test.ts`, mirroring Part A §4 of `_newmodule-account-plan.md`. A build unit is not done until its mapped V-tests exist and pass (CI gate, platform §10.4).
2. **Conservation and reversal properties** (V4, V13) are property-based tests and live beside the integration tests, not in unit folders.

---

## 8. Permission Names & Per-Page Map

Seeded `core.PERMISSIONS` names follow platform §8 snake_case — the plan's hyphenated labels map as: `accounts-view → accounts_view`, `accounts-transactions → accounts_transactions`, `accounts-config → accounts_config`. Typed constants in `auth/` (platform §8.5).

| Page              | Route                               | Component              | Permission : Level                                                                                                         |
| ----------------- | ----------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Accounts Overview | `/accounts/overview`                | `AccountsOverviewPage` | `accounts_view : READ`                                                                                                     |
| Ledger Explorer   | `/accounts/ledger`                  | `LedgerExplorerPage`   | `accounts_view : READ`                                                                                                     |
| Transactions      | `/accounts/transactions`            | `TransactionsPage`     | `accounts_transactions : READ` (view) / `EDIT` (draft, submit, post within limit, approve — approver ≠ creator in service) |
| Chart of Accounts | `/accounts/chart-of-accounts`       | `ChartOfAccountsPage`  | `accounts_config : READ` (view) / `EDIT` (codes, mappings)                                                                 |
| GL Journal        | `/accounts/gl-journal`              | `GlJournalPage`        | `accounts_config : READ` (view, drill-down) / `EDIT` (export, period close)                                                |
| Accounts Settings | `/administration/accounts-settings` | `AccountsSettingsPage` | `accounts_config : EDIT`                                                                                                   |

Onboarding wizard mutations (Customer-module UI) require `accounts_transactions : EDIT` **and** the Customer module's own transition permission — both checked in the action.

MANAGER-vs-USER approval routing is **not** a permission level — both hold `accounts_transactions : EDIT`; the threshold/role check (Q20) is a service-layer workflow rule on top of RBAC.

---

## 9. Result Error Code Catalog — as-built

Reconciled against shipped code 2026-08-06. This is the **complete** set of `{ ok: false, code }` strings returned by `services/accounts/**` and `actions/accounts/**` — **49 codes**, verified by diffing this table against every `code:` literal in those trees (zero undocumented, zero invented). It supersedes the seven-code list previously inlined in §2.4, which had fallen substantially behind the implementation.

### 9.1 Two error systems, deliberately separate

| System | Defined in | Mechanism | Used by |
|---|---|---|---|
| `APP_ERROR_CODES` | `lib/errors.ts` — `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `INTERNAL` | **Thrown** `AppError`; mapped to HTTP by `lib/http.ts` | Route Handlers, platform middleware |
| **Result codes (this catalog)** | Per-service union types | **Returned** `{ ok: false, code }`; never thrown | All `services/accounts/**` and `actions/accounts/**` |

`VALIDATION_ERROR` (Result) and `VALIDATION_FAILED` (AppError) are **different codes in different systems** — not a typo and not drift. Likewise `FORBIDDEN`, `NOT_FOUND` and `CONFLICT` exist as names in both; a Result `FORBIDDEN` is an action-boundary return value, not a thrown `AppError`.

### 9.2 Action boundary — every mutating action returns these

| Code | Returned by | Meaning |
|---|---|---|
| `FORBIDDEN` | 27 of 28 files in `actions/accounts/` | Permission/level check failed at the action boundary |
| `VALIDATION_ERROR` | 27 of 28 files in `actions/accounts/` | Zod parse failed; carries field errors |

Both are returned by services' callers, never by `services/accounts/**` itself (zero occurrences) — permission and payload checks belong at the action boundary, the services trust their already-validated inputs.

### 9.3 Document lifecycle — `document-state-machine.ts`, `post-document.ts`

| Code | Returned by | Meaning |
|---|---|---|
| `DOCUMENT_NOT_FOUND` | state machine, post-document, reversal services, `get-reversal-preview` | No document for the given id |
| `DOC_STATE_INVALID` | same set | Current state does not permit the requested transition |
| `APPROVAL_REQUIRED` | `post-document` | Amount is at/above the reason code's `auto_post_limit` (Q20) |
| `SELF_APPROVAL` | state machine, `post-document` | Approver equals creator (Q20, module inv. #6) |
| `PERIOD_CLOSED` | `post-document` | `event_at` falls in a closed period; carries the re-date hint (Q9) |
| `UNBALANCED_DOC` | `post-document` | Header total ≠ Σ lines |
| `ACCOUNT_CLOSED` | `post-document` | Target account is closed (Q11) |
| `CONFLICT` | state machine, `post-document`, reversal, closure, all catalog services | Optimistic-lock loser on `last_modified` (§2.5) |

### 9.4 Reversal — `reverse-document.ts`, `reverse-line.ts`, `get-reversal-preview.ts`

| Code | Returned by | Meaning |
|---|---|---|
| `ALREADY_REVERSED` | `reverse-document`, `reverse-line` | Every targeted line already carries `reversed_by_line_id` |
| `WRONG_FINANCIAL_ACCOUNT` | both + preview | Document does not belong to the FA in context |
| `LINE_NOT_FOUND` | `reverse-line` | A selected line id is absent, duplicated, or not on this document |
| `TRANSFER_NOT_FOUND` | `get-reversal-preview` | Posted line has no resolvable pgledger transfer |
| `INTERNAL_ERROR` | `actions/accounts/reverse-document.ts` **only** | Unexpected failure. **Outlier** — the sole action using this code; see §9.8 |

### 9.5 Entity resolution

| Code | Returned by | Meaning |
|---|---|---|
| `FINANCIAL_ACCOUNT_NOT_FOUND` | 12 services | FA id absent or not readable |
| `BILLING_ACCOUNT_NOT_FOUND` | 9 services | BAN absent, or not under the given FA |
| `PARTY_ROLE_NOT_FOUND` | `onboard-customer-accounts` | Customer party role absent |
| `SETTLED_DOCUMENT_NOT_FOUND` | `allocate-payment` | Allocation target document missing |
| `ALLOCATION_LINE_NOT_FOUND` | `refund-payment` | Referenced allocation line missing |
| `CYCLE_NOT_FOUND` | `bill-cycle` | Bill cycle id absent |
| `GL_CODE_NOT_FOUND` | `gl-mapping` | Referenced GL code absent |
| `PARENT_NOT_FOUND` | `gl-account` | Parent CoA node absent |
| `CONFIG_NOT_FOUND` | `bill-cycle`, `wizard-defaults` | Config row absent |
| `NOT_FOUND` | `bill-cycle`, `gl-account`, `gl-mapping`, `reason-code` | Generic catalog-entity miss |

### 9.6 Amount and balance guards

| Code | Returned by | Meaning |
|---|---|---|
| `AMOUNT_EXCEEDS_OPEN_RECEIVABLE` | `write-off`, `rounding-adjustment` | Amount exceeds the BAN's open A/R |
| `AMOUNT_EXCEEDS_HELD_DEPOSIT` | `reverse-deposit` | Amount exceeds the FA's held deposit |
| `AMOUNT_EXCEEDS_REFUNDABLE` | `refund-deposit` | Amount exceeds the refundable deposit balance |
| `AMOUNT_EXCEEDS_ORIGINAL` | `refund-payment` | Refund exceeds the original payment |
| `INSUFFICIENT_UNAPPLIED_CASH` | `refund-payment` | Not enough unapplied cash to satisfy the refund |
| `ALREADY_REFUNDED` | `refund-payment` | Payment already refunded |
| `CONVERT_TO_ADVANCE_REQUIRES_APPLICATION` | `refund-payment` | Conversion to advance needs an application target |
| `NO_ITEMS_SELECTED` | `refund-payment` | No assigned items chosen |
| `NO_RESIDUE_TO_CLEAR` | `rounding-adjustment` | Nothing left to round |
| `UNSUPPORTED_CURRENCY` | `refund-payment` | Currency outside operational scope (MYR, Q12) |

### 9.7 Closure, period, catalog and journal

| Code | Returned by | Meaning |
|---|---|---|
| `CLOSURE_BLOCKED` | `close-billing-account`, `close-financial-account` | Non-zero balance blocks closure (Q11, module inv. #12) |
| `ALREADY_CLOSED` | both closure services, `period-close` | Target already closed |
| `INVALID_TRANSITION` | `onboard-customer-accounts` | Customer status transition not permitted — **not** a document-state code |
| `CYCLE_RETIRED` | `bill-cycle`, `onboard-customer-accounts` | Assignment attempted against a retired cycle (Q13, module inv. #11) |
| `ALREADY_RETIRED` | `bill-cycle`, `gl-account`, `gl-mapping`, `reason-code` | Catalog row already retired |
| `ORPHAN_BLOCK` | `gl-account`, `gl-mapping` | Retirement would orphan dependent rows |
| `NON_POSTABLE_TARGET` | `gl-mapping` | Mapping points at a non-postable GL node |
| `IMMUTABLE_FIELD` | `reason-code` | Attempt to edit a write-once field |
| `DUPLICATE_CODE` | `reason-code` | Reason code already exists |
| `DUPLICATE_GL_CODE` | `gl-account` | GL code already exists |
| `DUPLICATE_NAME` | `bill-cycle` | Cycle name already exists |
| `DUPLICATE_SELECTOR` | `gl-mapping` | Mapping selector already exists |
| `LAST_MODIFIED_REQUIRED` | `bill-cycle`, `reason-code` | Optimistic-lock token missing from an edit payload |
| `UNBALANCED_JOURNAL` | `journal-csv` | Σ debit ≠ Σ credit; blocks export (V6, module inv. #10) |

### 9.8 Known inconsistencies (cleanup candidates, not blockers)

1. **`INTERNAL_ERROR` is used by exactly one action** (`actions/accounts/reverse-document.ts`). Every other action lets an unexpected failure surface through the platform path. Either promote it to a documented action-boundary code alongside `FORBIDDEN`/`VALIDATION_ERROR`, or remove it — do not copy the pattern into new actions meanwhile.
2. **`NOT_FOUND` overlaps four specific codes.** The catalog services return generic `NOT_FOUND` where entity-specific codes (`CYCLE_NOT_FOUND`, `GL_CODE_NOT_FOUND`, …) also exist. New code uses the specific form; the generic remains for the existing call sites only.
3. **Adding a code is a doc change.** Any new Result code lands in this section in the same change set — §2.4's rule, enforced here.
