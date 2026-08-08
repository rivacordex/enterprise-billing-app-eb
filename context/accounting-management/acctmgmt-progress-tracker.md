# Completed Tracker — Accounts Module

17 of 17 original units delivered (ac01–ac17). The Transactions revision is now underway: `ac18`–`ac19` delivered. **Next up: `ac20`** (documents table, retires `PendingApprovalsList`).

## Status Table

| Unit | Name | Status |
| ---- | ---- | ------ |
| ac01 | pgledger Foundation (vendored fork, transform pipeline, ULID helpers, `billing.*` migration) | Delivered |
| ac02 | Module Tables & Views (10 `billing.*` tables, 3 composition views, repository skeletons) | Delivered |
| ac03 | Seed Set + GL Health (sys accounts, CoA, GL mappings, reason codes, bill cycles) | Delivered |
| ac04 | Customer Onboarding Wizard (atomic FA/BAN/ledger/binding creation on VALIDATED) | Delivered |
| ac05 | Accounts Nav + Overview (search, FA/BAN detail, live balances, URL context strip) | Delivered |
| ac06 | Ledger Explorer (account picker, transfers grid, two-leg drawer, zero-sum strip) | Delivered |
| ac07 | Document Core + PAY (`money.ts`, state machine, atomic posting, capture + allocation) | Delivered |
| ac08 | Deposit Operations — DEP (capture, reverse-to-account, refund) | Delivered |
| ac09 | Billed-Amount Operations — CRN/DBN (raise-debit-note, raise-credit-note) | Delivered |
| ac10 | Adjustments — ADJ (write-off, rounding-adjustment) | Delivered |
| ac11 | Reversal Workbench (doc-level + line-level reversal of any posted doc type) | Delivered |
| ac12 | Chart of Accounts page (CoA tree, GL code CRUD, GL mapping CRUD, F5 orphan-block) | Delivered |
| ac13 | GL Journal page (period selector, movement/trial-balance toggle, drill-down, V6 balance) | Delivered |
| ac14 | Period Close + CSV Export (close action, PERIOD_CLOSED re-date UX, GL journal CSV export) | Delivered |
| ac15 | Accounts Settings (reason-code + threshold CRUD, bill-cycle catalog CRUD, wizard defaults) | Delivered |
| ac16 | Account Closure Gates (zero-balance BAN/FA closure, guided settle-first path, Customer CLOSED block) | Delivered |
| ac17 | Guardrail & Authz Sweep (route × level matrix, V1–V14 audit, grep gates, docs sync) | Delivered |
| ac18 | Nav Order + Selection-Context Handoff (Transactions moves to position 2, `?party&fa&ban` propagates across all five Accounts nav links) | Delivered |
| ac19 | Action Launcher + Dialog Shells (three-control action bar, `DropdownMenu` primitive, ten panels moved into dialogs) | Delivered |

## Unit Summaries

**ac01 — pgledger Foundation.** Vendored `pgr0ss/pgledger` (MIT, commit `43240db`) into `db/pgledger/`. Transform pipeline (`npm run pgledger:transform`) rewrites pgledger's SQL into the `billing` schema. Vendor ULID helper from `scoville/pgsql-ulid` (BSD-3-Clause) as `billing.uuid_to_ulid`. Migration `0011_billing_pgledger.sql`. V1 zero-sum integration test green.

**ac02 — Module Tables & Views.** 10 `billing.*` Drizzle tables (`accounts`, `catalogs`, `documents`, `ledger-binding`, `periods`) with sequences, CHECK constraints, and cross-schema FKs. 3 composition views (`account_view`, `gl_resolution_view`, `gl_journal_view`) as raw SQL in `db/schema/billing/views.sql`, declared `.existing()` in `views.ts`. Migration `0012_billing_module_tables.sql`. Repository skeletons. Types in `types/accounts.ts`. JSONB shape guards in `validation/accounts/`.

**ac03 — Seed Set + GL Health.** Six `sys.*` MYR pgledger accounts; 11-node CoA in `billing.gl_account`; nine `billing.gl_mapping` rows; ten `billing.reason_code` rows; two `billing.bill_cycle` rows; three `core.system_config` wizard-default rows. Idempotent seed script `db/seeds/accounts/seed-accounts.ts`. V5 GL-resolution integration test green. Key resolution: `deposit_movement` natures steer to `sys.cash` (no dedicated sys account); `ACCOUNTS_DEFAULT_CREDIT_LIMIT` seeded as NULL.

**ac04 — Customer Onboarding Wizard.** One atomic `db.transaction`: `compareAndUpdateStatus → VALIDATED`, FA insert, BAN insert, three `pgledger_create_account` calls, three `ledger_binding` rows, `ACCOUNTS_ONBOARDED` audit event. Dual-permission check (`accounts_transactions:EDIT` + `customers:EDIT`). Wizard dialog injected into `customer-role-form.tsx`. Returning-customer gate shows prior FAs. `services/accounts/term-resolution.ts`. V2 binding-integrity and V7 onboarding-atomicity tests.

**ac05 — Accounts Nav + Overview.** `accounts_view` permission migration `0015`. `money.ts` bigint-sen arithmetic. `ledgerRepository.balanceByLedgerAccountId`. Overview page (`force-dynamic`, native GET, no write affordance). `AmountCell`, `PaymentStatusBadge`, `ContextStrip` components. `parseAccountsContext` URL parser. V3 live-balance integration test.

**ac06 — Ledger Explorer.** `LedgerKindChip`, `BalanceCheckStrip` (V1 surfaced live), `LedgerAccountPicker`, `LedgerTransfersGrid`, `TransferDetailDrawer`. `services/accounts/ledger-explorer.ts`. `ledger.repository.ts` extended. `/accounts/ledger` page, `force-dynamic`, `accounts_view:READ`. V6 journal-balance integration test.

**ac07 — Document Core + PAY.** Posting spine: `document-state-machine.ts` (`submitDocument`, `approveDocument`, `cancelDocument`); `post-document.ts` (sole `pgledger_create_transfers` caller, guard/balanced-doc/period-validation/nature-steering/audit); `leg-templates.ts` (PAY `capture`/`allocation`/`release`/`refund`); `capture-payment.ts`, `allocate-payment.ts`, `refund-payment.ts`. `accounts_transactions` permission migration `0017`. Five validation schemas + five actions. Doc-state badge, five UI panels, `/accounts/transactions` page. V3-balance, V8-payment-status, V11-state-machine integration tests. Key design: `postExplicitLegs` implemented and exported for ac11 arbitrary reversals; PAY refund uses a registered `release` leg template, not `postExplicitLegs`.

**ac08 — Deposit Operations.** `leg-templates.ts` extended with DEP entries (`capture`: `fa.deposits → sys.cash`; `release`: `fa.unapplied_cash → fa.deposits`; `refund`: reuses PAY refund). `LegTemplateContext` gained `financialAccountDepositsId`. `capture-deposit.ts`, `reverse-deposit.ts`, `refund-deposit.ts`. Three panels wired into `/accounts/transactions`. V14 deposit-lifecycle integration test (5 tests). Key resolution: `deposit_movement → sys.cash` via `NATURE_SYS_ACCOUNT_NAME` map; the only required edit to ac07's posting core.

**ac09 — Billed-Amount Operations (CRN/DBN).** `leg-templates.ts` extended with `DBN`/`CRN` entries. `LegTemplateContext` gained `taxSysAccountId` (resolved unconditionally, mirrors `financialAccountDepositsId`). `raise-debit-note.ts`, `raise-credit-note.ts`. Two panels greyed until both `?fa` and `?ban` present. V12 posting-nature-steering test started (7 tests). Key design: DBN tax line reuses `release` as a disambiguating `(doc_type, line_kind)` map key — no schema change.

**ac10 — Adjustments (ADJ).** `leg-templates.ts` extended with `ADJ_LEG_TEMPLATES` (`charge`/`release`). No `post-document.ts` change needed — `write_off`/`rounding` natures already in `NATURE_SYS_ACCOUNT_NAME` since ac03. `write-off.ts`, `rounding-adjustment.ts`. Two panels, both require `?fa` + `?ban`. V12 extended to 12 tests. Key design: rounding direction derived from live receivables balance sign inside the transaction; zero balance rejected as `NO_RESIDUE_TO_CLEAR`.

**ac11 — Reversal Workbench.** `get-reversal-preview.ts`, `reverse-document.ts`, `reverse-line.ts`. `postDocument` extended with reversal detection (`doc.reversalOf != null` → reads `metadata.reversalLegs` → calls `finalizePosting` directly). `reverseDocumentAction` routes to `reverseLine`/`reverseDocument` based on `selectedLineIds`. `reversals-panel.tsx` client component. V13 line-reversal-conservation property test (fast-check). V4 cash-conservation property test extended. Key design: `metadata.reversalLegs` stored at creation time; `reversedByLineId` stamped before `submitDocument` as durable double-reversal lock; `reverse-line.ts` uses post-stamp re-read for "all lines reversed" check (READ COMMITTED sees concurrent committed stamps).

**ac12 — Chart of Accounts.** Migration `0020_accounts_config_permission.sql` (inserts `accounts_config` permission row + `CREATE OR REPLACE VIEW billing.gl_resolution_view` adding `AND state = 'active'` to fix the migration-0018 gap). `gl-account.repository.ts`, `gl-mapping.repository.ts` replaced with full CRUD. `gl-health.ts`, `gl-account.ts`, `gl-mapping.ts` services. Four server actions (`accounts_config:EDIT`). CoA page (`force-dynamic`, `accounts_config:READ`). V5-gl-health-crud integration test. Key design: F5 orphan-block via in-transaction `countUnmappedAccounts` post-mutation, rolling back via `OrphanBlockError` on count > 0; depth-based indentation via `DEPTH_PL` lookup table (Tailwind can't purge dynamic classes).

**ac13 — GL Journal Page.** `gl-journal.repository.ts` (`listSummary` over `gl_journal_view`; `listDrilldown` via `pgledger_entries_view` + `gl_resolution_view`). `services/accounts/gl-journal.ts`. `gl-journal-search-params.schema.ts` (all fields with `.catch()` fallbacks). GL Journal page (`force-dynamic`, `accounts_config:READ`, period selector, movement/trial-balance toggle, sortable table, drill-down expansion, balanced-flag total row). V6 journal-balance integration test extended.

**ac14 — Period Close + CSV Export.** `accounting-period.repository.close` (lazy-create idempotent). `document.repository.updateEventAt` (CAS). `period-close.ts`, `journal-csv.ts` (RFC 4180 CRLF, `serializeJournalCsv`, `buildJournalCsv`). `document-state-machine.ts` extended with `redateAndResubmit` (sentinel `_FailResult` pattern). `close-period.action.ts` (`accounts_config:EDIT`); `redate-and-post.action.ts` (`accounts_transactions:EDIT`). `/api/accounts/gl-journal-export` Route Handler (POST, manual auth — cannot use `requirePermission` in Route Handlers). `ClosePeriodButton`, `JournalExportButton` client components. GL Journal page extended with period-state section. V6b period-close-export integration test (11 tests). Key design: `redateAndResubmit` uses `_FailResult extends Error` sentinel to guarantee rollback; `PERIOD_CLOSED` used both as a `PostDocumentResult` error code and an audit event type — no collision.

**ac15 — Accounts Settings.** `reason-code.repository.ts` (full CRUD + `retire` CAS). `bill-cycle.repository.ts` extended with full CRUD + `retire` CAS. Three validation schemas. `reason-code.ts`, `bill-cycle.ts`, `wizard-defaults.ts` services. Five server actions (`accounts_config:EDIT`). Three client-component forms. Accounts Settings page (four sections: reason codes, bill cycles, wizard defaults, flows link). Flows reference page (`accounts_config:READ`, config-driven doc-flow + GL mapping + live catalogs). `admin-nav.tsx` extended. V9 bill-cycle-integrity integration test. V10 term-resolution unit test.

**ac16 — Account Closure Gates.** `closure-eligibility.ts` (`canCloseBillingAccount`, `canCloseFinancialAccount`, `customerHasOpenAccounts`). `billingAccountRepository.close`, `financialAccountRepository.close` (CAS, four-outcome pattern). `close-billing-account.ts`, `close-financial-account.ts` services (gate + CAS + `ACCOUNT_CLOSED` audit in one transaction). `post-document.ts` `guardAndLoad` extended with closed-account check (single choke point for all ac07–ac11 paths). Two close actions (`accounts_transactions:EDIT`). `closure-panel.tsx` wired into `/accounts/transactions`. cm10 touchpoint in `transition-customer-status.ts`. V14 extended with full guided-closure sequence (13 tests total). Key design: closure UI on Transactions page (not Overview); no separate live-preview server action (page-level `router.refresh()` re-runs eligibility reads for free).

**ac17 — Guardrail & Authz Sweep.** Pure gate unit — tests + CI grep gates + docs only; no feature/schema/UI change. Three new test files: `route-level-matrix.test.ts` (six pages + export route `(permission, level)` gates, threshold routing, approver≠creator), `verification-audit.test.ts` (V1–V14 presence/naming/mapping, Inv.#1–14 ↔ V-test cross-reference), `grep-gates.test.ts` (eight static CI gates, tree-wide). 119 new tests, all green. `db/migrations/0020_accounts_config_permission.sql` journal entry registered (was authored but missing). Three genuine pre-existing defects found and fixed: `amount-cell.tsx` raw `Number()`/`< 0` violation; `reason-code-form.tsx` and `accounts-settings/flows/page.tsx` `parseFloat() === 0` violations; `roles-read.service.integration.test.ts` hardcoded permission list missing three Accounts permissions.

**ac18 — Nav Order + Selection-Context Handoff.** `components/admin-nav.tsx` only (D6+D7, ac18-spec). `NavSection` gained `carriesAccountsContext?: boolean`, set on the Accounts section only. Accounts items reordered to Overview → Transactions → Ledger Explorer → Chart of Accounts → GL Journal under a single caption. Module-private `accountsContextQuery` helper routes `useSearchParams()` through the existing `parseAccountsContext` (still the only parser) and allowlists exactly `party`/`fa`/`ban` in that fixed order into a `linkHref` computed separately from `item.href`, so `isActive`/`key`/`aria-current` keep resolving off the bare pathname. Locked items are untouched (still `href`-less). Three existing test files (`admin-nav.test.tsx`, `admin-sidebar.test.tsx`, `admin-layout.test.tsx`) extended with a `useSearchParams` mock; new `admin-nav-accounts-context.test.tsx` covers order, propagation, scope, allowlist, validation, empty-context, determinism, active-state and locked-item behavior. No schema, permission, or style change.

**ac19 — Action Launcher + Dialog Shells.** `components/ui/dropdown-menu.tsx` (new shared primitive — `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuSeparator` — built on the already-installed unified `radix-ui` package, mirroring `select.tsx`'s import style; available to all modules thereafter). `components/accounts/transactions-action-bar.tsx` (three triggers — **+ Payment**, **+ Note**, **More actions** (D3) — owning `openAction: ActionKey | null` client state and the per-entry FA/FA+BAN context-gating predicate). `components/accounts/transaction-dialogs.tsx` (ten `Dialog`+`DialogContent`+`DialogTitle` wrappers, one per create-panel). `app/(app)/accounts/transactions/page.tsx`: the ten inline panel renders replaced by `<TransactionsActionBar>`; `ReversalsPanel`, `ClosurePanel`, `PendingApprovalsList` untouched. All ten panel files verified byte-unchanged (props/schema/action/error-mapping, inv. #20) — `grep-gates.test.ts` gained a static check that no panel module imports `Dialog`. Reversal stays absent from all three menus (D4, deferred to ac22). Key design: the panel's own `<h3>` is visually dropped via a wrapper-scoped `[&_h3]:hidden` CSS selector (not a panel edit) in favour of `DialogTitle`; none of the ten panels expose an `onSuccess` callback today, so every dialog stays open on submit showing the panel's own success message (no success-plumbing added, per inv. #20).

## Key Module-Wide Architectural Decisions

- **`NATURE_SYS_ACCOUNT_NAME` map** in `post-document.ts` steers posting natures to sys-account names; `deposit_movement` maps to `"cash"` (not an identity mapping) so DEP legs use `sys.cash` with no dedicated `sys.deposit_movement` account.
- **`leg-templates.ts`** is keyed on `(doc_type, line_kind)` — different doc types can reuse the same `line_kind` string with different semantics (e.g., `(DEP, release)` vs `(PAY, release)` vs `(DBN, release)` for the tax leg).
- **`postExplicitLegs`** is the primitive for truly arbitrary reversal legs (ac11); the generic `postDocument` approval path is unchanged for ac08–ac10 reuse.
- **`metadata.reversalLegs`** stores pre-computed opposite legs at reversal creation time, not re-derived at posting time, so the generic four-eyes approval flow works for reversals without extra lookups.
- **`migrate()`-poisons-connection quirk** (drizzle-orm + postgres-js): `migrate()` run on a connection leaves its type-OID cache poisoned — later `timestamp(tz)` reads on the same connection return raw strings. Workaround used throughout: schema-drop + `migrate()` on a short-lived connection, close it, then open a fresh connection for test reads.
- **`drizzle-orm` `sql\`\`` vs raw `postgres.js` sql tag jsonb binding**: `db.execute(sql\`...\`)` (drizzle template) requires `JSON.stringify()` before interpolating a jsonb-bound value; a raw `postgres.js` tag auto-serializes objects (pre-stringifying double-encodes). Rule is per-code-path.
- **Route Handler auth** cannot use `requirePermission` (which calls `redirect()`). Use `auth.api.getSession` → `findActiveUserById` → `resolveEffectivePermissions` → `meetsLevel` directly, returning `Response.json` 401/403.
- **`clearValueIfEquals`** in `system-config.repository.ts` closes the TOCTOU window in `retireBillCycle`'s config-clear step — a single atomic `UPDATE … WHERE config_value = ?` that is a safe no-op if the value was already changed by a concurrent writer.
- **V-test → Invariant cross-reference** is now a permanent, executable fact in `verification-audit.test.ts` — not just prose.

## Resolved Open Questions (summary)

All Q1–Q28 from `_newmodule-account-plan.md` resolved. Key resolutions:
- Q1: BAN required for CRN/DBN/ADJ operations at schema level; FA-only for DEP.
- Q4: DEP panels grey until `?fa`; CRN/DBN/ADJ panels grey until both `?fa` and `?ban`.
- Q9: Absent `accounting_period` row treated as open; only an existing `state = 'closed'` row rejects a post.
- Q11: Closure-eligible when `deposits = 0` and `unapplied = 0`.
- Q16: Deposits reconcile to `sys.cash`, not a dedicated `sys.deposit_movement` account.
- Q20: Threshold routing in `submitDocument`; four-eyes docs route to `pending_approval`.
- Permission choice (ac16): `accounts_transactions:EDIT` for closure actions (operational act, not config).
