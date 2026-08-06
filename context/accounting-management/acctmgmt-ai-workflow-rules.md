# AI Coding Agent Workflow Rules — Accounting Module Supplement

Obey every rule in `context/ai-workflow-rules.md` unchanged; this supplement adds only the Accounting-module deltas — its concrete units, mutations, guardrails, protected files, and doc-sync targets. Authoritative companions: `acctmgmt-project-overview.md`, `acctmgmt-architecture.md` (module invariants #1–14), `acctmgmt-code-standards.md`, and the decision log Q1–Q28 in `_newmodule-account-plan.md`. On conflict, follow the platform precedence chain; module invariants rank with architecture Invariants.

---

## 1. Operating Approach — module deltas

1. Cite a decision number or a doc section for every unit you start. If nothing authorizes the work, stop and ask. **Two closed decision logs govern this module:** `Q1–Q28` in `_newmodule-account-plan.md` (original build) and `D1–D7` in `_updatemodule-accounts-transactions-plan.md` (Transactions revision). Both are fully resolved; do not reopen a resolved Q or D on your own. Work on the Transactions page cites D-numbers where a D supersedes or narrows a Q.
2. Treat money-touching code as high-risk by default: any unit that calls the posting service, adds a ledger leg, or changes a `sys.*` account, reason code, or GL mapping requires its mapped V-test (§5) in the same unit. No exceptions.
3. Do not begin any UI unit before the pgledger fork migration, module-table migrations, and seeds are merged and their V-tests pass. Data core first, always.

## 2. Scoping — the module's units

Deliver in this dependency order. One unit per pass; each row is the maximum size of one unit — split further per platform §3 whenever a row bundles a schema change with behavior.

1. ULID helpers + pgledger fork migration (`db/pgledger/` transform output) — schema only.
2. Module tables migration set: `financial_account`, `billing_account`, `bill_cycle`, `reason_code`, `ledger_binding`, `document`, `document_line`, `gl_account`, `gl_mapping`, `accounting_period` + views (`account_view`, `gl_resolution_view`, `gl_journal_view`) + `PERMISSIONS` rows (`accounts_view`, `accounts_transactions`, `accounts_config`).
3. Seeds: sys ledger accounts (one per posting nature per Q19), CoA, GL mappings, reason codes, bill cycles — with the GL-health seed test (V5).
4. `services/accounts/money.ts` — the only money-arithmetic site (code-standards §2.2).
5. Onboarding service + Customer-module wizard integration (Q2) — the atomic FA/BAN/ledger/binding transaction (V7).
6. Document core: state machine + posting service (`post-document.ts`) with period validation (Q9) and posting-nature steering (Q19) — V11, V12.
7. Per-operation actions, one unit each (§3 below).
8. Pages, one unit per page per read path: Accounts Overview, Ledger Explorer, Transactions (read), Chart of Accounts, GL Journal, Accounts Settings.
9. Period close + `POST /api/accounts/gl-journal-export` (V6).
10. Closure gates (Q11) — V14.

## 3. Mutations — each is its own unit

One Server Action per operation (code-standards §3.3); never a generic document action. Build read paths before any of these:

capture payment (PAY) · allocate payment lines · capture deposit (DEP) · deposit reverse-to-account · deposit refund · raise credit note (CRN) · raise debit note (DBN) · write-off / rounding adjustment (ADJ) · submit for approval · approve (approver ≠ creator) · reverse document · reverse single line · cancel draft · period close · CoA code create/retire · GL mapping create/edit · reason-code create/edit/retire · bill-cycle create/edit/retire · journal CSV export · onboard FA/BAN (wizard).

## 4. Missing or Ambiguous Requirements — module deltas

1. Never guess a ledger leg. If the from/to accounts for an operation are not explicit in the plan (Q4, Q15, Q16, Q17, Q19 legs), stop and ask. Do not infer legs from accounting intuition.
2. Never guess a sign. The signed-balance convention is encapsulated in `money.ts` helpers (code-standards §2.3); if a comparison isn't expressible with an existing helper, stop and ask rather than writing a raw sign check.
3. Never invent a reason code, posting nature, sys account, GL code, or threshold. These are seed/config data with Q-references; a missing one is a spec gap to raise, not a row to add.
4. Record every new resolution in the log that owns the surface — the next **Q-number** in `_newmodule-account-plan.md` for module-wide/data-core decisions, or the next **D-number** in `_updatemodule-accounts-transactions-plan.md` for Transactions-page decisions — **and** in the owning context doc, in the same change set. Never open a third log.

## 5. Guardrails — verification tests you must keep green

The module's guardrails are the 14 verification tests in `_newmodule-account-plan.md` Part A §4, filed as `tests/accounts/v01…v14` (code-standards §7.1). Map units to tests: zero-sum V1 · bindings V2 · live balances V3 · cash conservation V4 · GL resolution V5 · journal balance V6 · atomicity V7 · payment-status derivation V8 · catalog integrity V9 · term resolution V10 · document state machine V11 · nature steering V12 · line-level reversal V13 · deposit lifecycle V14. Run V1 (zero-sum) at the end of **every** integration test that posts anything; a non-zero sum anywhere fails the unit regardless of what the unit was about.

## 6. Files You Must Not Modify — module additions

Beyond platform §5, do not touch without explicit instruction:

1. `db/pgledger/pgledger.sql` (vendored upstream), `UPSTREAM_COMMIT`, and any generated transform output — regenerate via `transform.ts` only, never hand-edit (module inv. #14).
2. The pgledger tables themselves from application code — no DML, no direct `SELECT` on `pgledger_*` base tables; functions and views only (module inv. #4). This includes tests: assert through the views.
3. `services/accounts/money.ts` beyond its defined API — no second arithmetic site, no `parseFloat`/`Number()` on amounts anywhere in the module.
4. Seed files for sys accounts, CoA, GL mappings, and reason codes once merged — changes are new migrations/config units with V5 re-run, not edits.
5. Applied period-close records and posted documents in any fixture or seed — corrections are reversal documents (module inv. #4); never mutate a posted fixture to make a test pass.

## 7. Front-End Permission Mapping — module deltas

Use the six-row page map in `acctmgmt-code-standards.md` §8 verbatim — permission names are snake_case (`accounts_view`, `accounts_transactions`, `accounts_config`). Three module-specific rules: (1) MANAGER approval routing is a service-layer rule, not a permission level — never model it as a fourth permission or a DELETE level; (2) the Transactions page renders **create** actions disabled until the URL context strip satisfies Q1's requirements, and the action re-validates the same requirement server-side; (3) **disabled and hidden are different rules on this page — do not conflate them.** Context-gating disables (rule 2); *document eligibility* hides — the reversal control is not rendered at all on documents that are not `posted` with an unreversed line (D4). Neither is authorization: the service re-validates regardless (architecture inv. #18).

## 8. Verification Checklist — module additions

Before closing any unit, in addition to platform §8:

1. The unit's mapped V-tests (§5) exist and pass; V1 zero-sum holds after every posting test.
2. No file outside `db/repositories/accounts/` references a pgledger function or view (grep-verifiable); no file outside `money.ts` does money arithmetic.
3. Every posted line in test fixtures has a `pgledger_transfer_id` and every transfer's `metadata.doc` round-trips to its document (module inv. #3).
4. Accounts pages remain `force-dynamic`; no `revalidate` or cached fetch was introduced on balance-bearing routes.
5. Approval-path tests cover: below-limit USER post succeeds, above-limit USER post → `pending_approval`, self-approval rejected, non-creator MANAGER approval posts.
6. If the unit touched documents: posting into a closed period is rejected with `PERIOD_CLOSED` and the original `event_at` is preserved (Q9).
7. `acctmgmt-progress-tracker.md` is updated with the unit's status in the same change set.
