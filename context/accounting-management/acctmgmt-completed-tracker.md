# Completed Tracker — Accounts Module

**Status:** all 24 units delivered — original module ac01–ac17, Transactions revision (D1–D7) ac18–ac23, field-mapping correction ac24 (Entry Date / Reference Date caption + `reference_date`→`entry_date` rename). The revision closed with ac23's guardrail + authz sweep (tests + docs only, zero application code). Its scope has been merged into `acctmgmt-project-overview.md`, and `acctmgmt-update-overview.md` has been removed (dropped from the AGENTS.md reading order). Shared primitive `components/ui/dropdown-menu.tsx` added (available module-wide); `components/accounts/reversals-panel.tsx` removed (SC10) — reversal is document-bound via `reversal-dialog.tsx`. **Next Accounts work: the deferred Account Lifecycle change (D1) — see Deferred Items.**

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
| ac19 | Action Launcher + Dialog Shells (`+ Payment`, `+ Note`, `More actions` bar; ten panels wrapped in `Dialog`; `DropdownMenu` primitive added) | Delivered |
| ac20 | Documents Table (filterable paginated table, scope predicate, partially-reversed badge, approval banner, retire `PendingApprovalsList`) | Delivered |
| ac21 | Document Detail Drawer (URL-driven drawer, per-line reversed state, ledger legs, approve from drawer, remove inline approve stopgap) | Delivered |
| ac22 | Row-Level Reversal (document-bound reversal dialog, ↺ Reverse on eligible rows + drawer footer, line checkboxes route reverseDocument/reverseLine, `ReversalsPanel` deleted) | Delivered |
| ac23 | Guardrail & Authz Sweep — Transactions revision (route × level affordance matrix, eight static gates, SC-completeness audit, SC12 unmodified-V-test check, docs sync) | Delivered |
| ac24 | Entry Date / Reference Date field-mapping & column-name correction (swap UI captions to match real behavior; rename `reference_date` → `entry_date`; `event_at` unchanged) | Delivered |

## Unit Summaries

### Original module (ac01–ac17)

- **ac01 — pgledger Foundation.** Vendored `pgr0ss/pgledger` (MIT, `43240db`) into `db/pgledger/`; transform pipeline (`npm run pgledger:transform`) rewrites its SQL into the `billing` schema; ULID helper `billing.uuid_to_ulid` (from `scoville/pgsql-ulid`); migration `0011`. V1 zero-sum green.
- **ac02 — Module Tables & Views.** 10 `billing.*` Drizzle tables + 3 composition views (`account_view`, `gl_resolution_view`, `gl_journal_view` — raw SQL, declared `.existing()`); migration `0012`; repository skeletons; `types/accounts.ts`; JSONB shape guards in `validation/accounts/`.
- **ac03 — Seed Set + GL Health.** Six `sys.*` MYR accounts, 11-node CoA, 9 `gl_mapping`, 10 `reason_code`, 2 `bill_cycle`, 3 `system_config` wizard defaults; idempotent `seed-accounts.ts`. V5 green. `deposit_movement` steers to `sys.cash`; `ACCOUNTS_DEFAULT_CREDIT_LIMIT` seeded NULL.
- **ac04 — Customer Onboarding Wizard.** One atomic `db.transaction`: status→VALIDATED + FA + BAN + 3 pgledger accounts + 3 bindings + `ACCOUNTS_ONBOARDED` audit; dual-permission (`accounts_transactions:EDIT` + `customers:EDIT`); wizard in `customer-role-form.tsx`; `term-resolution.ts`. V2 + V7.
- **ac05 — Accounts Nav + Overview.** `accounts_view` migration `0015`; `money.ts` bigint-sen arithmetic; Overview page (`force-dynamic`, read-only); `ContextStrip`/`AmountCell`/`PaymentStatusBadge`; `parseAccountsContext`. V3.
- **ac06 — Ledger Explorer.** `/accounts/ledger` page (`accounts_view:READ`); account picker, transfers grid, two-leg drawer, live zero-sum strip; `services/accounts/ledger-explorer.ts`. V6.
- **ac07 — Document Core + PAY.** Posting spine: `document-state-machine.ts`, `post-document.ts` (sole `pgledger_create_transfers` caller), `leg-templates.ts`; `capture/allocate/refund-payment.ts`; `accounts_transactions` migration `0017`. V3/V8/V11. `postExplicitLegs` exported for ac11.
- **ac08 — Deposit Operations (DEP).** `leg-templates.ts` DEP entries; `capture/reverse/refund-deposit.ts`; `LegTemplateContext.financialAccountDepositsId`. V14. `deposit_movement → sys.cash` via `NATURE_SYS_ACCOUNT_NAME`.
- **ac09 — Billed-Amount Ops (CRN/DBN).** `leg-templates.ts` DBN/CRN entries; `raise-debit/credit-note.ts`; `taxSysAccountId`; panels grey until `?fa`+`?ban`. V12 started. DBN tax line reuses `release` as a `(doc_type, line_kind)` key.
- **ac10 — Adjustments (ADJ).** `ADJ_LEG_TEMPLATES` (`charge`/`release`); `write-off.ts`, `rounding-adjustment.ts`; no `post-document.ts` change. V12→12 tests. Rounding direction from live receivables sign; zero balance → `NO_RESIDUE_TO_CLEAR`.
- **ac11 — Reversal Workbench.** `get-reversal-preview.ts`, `reverse-document.ts`, `reverse-line.ts`; `postDocument` reversal detection via `metadata.reversalLegs`. V13 + V4 property tests (fast-check). `reversedByLineId` stamped as durable double-reversal lock.
- **ac12 — Chart of Accounts.** Migration `0020` (`accounts_config` permission + `gl_resolution_view` `state = 'active'` fix); full CRUD on gl-account/gl-mapping repos; `gl-health.ts`; CoA page (`accounts_config`). V5. F5 orphan-block via in-transaction `countUnmappedAccounts` rollback.
- **ac13 — GL Journal Page.** `gl-journal.repository.ts` (`listSummary`/`listDrilldown`); page (`accounts_config:READ`, period selector, movement/trial-balance toggle, drill-down, balanced-flag total row). V6 extended.
- **ac14 — Period Close + CSV Export.** `accounting-period.repository.close` (idempotent) + `document.repository.updateEventAt` (CAS); `period-close.ts`, `journal-csv.ts` (RFC 4180 CRLF); `redateAndResubmit` (`_FailResult` rollback sentinel); export Route Handler (manual auth — no `requirePermission`). V6b.
- **ac15 — Accounts Settings.** Full CRUD on reason-code/bill-cycle repos (+ `retire` CAS); `wizard-defaults.ts`; Settings page (4 sections) + flows reference page; `admin-nav.tsx`. V9 + V10.
- **ac16 — Account Closure Gates.** `closure-eligibility.ts`; `close-billing/financial-account.ts` (gate + CAS + `ACCOUNT_CLOSED` audit); `post-document.ts` `guardAndLoad` closed-account check (single choke point for ac07–ac11); `closure-panel.tsx` on Transactions; cm10 touchpoint. V14→13 tests.
- **ac17 — Guardrail & Authz Sweep.** Tests + CI grep gates + docs only. Three test files (route-level matrix, V1–V14 audit, 8 static grep gates); 119 tests. Registered missing `0020` journal entry; fixed 3 pre-existing `money.ts`/permission-list defects.

### Transactions revision (ac18–ac23)

- **ac18 — Nav Order + Context Handoff.** `components/admin-nav.tsx` only: Accounts reordered to Overview → Transactions → Ledger Explorer → CoA → GL Journal under one caption; module-private `accountsContextQuery` allowlists `party`/`fa`/`ban` into a separate `linkHref` (via the existing `parseAccountsContext`), so `isActive`/`key`/`aria-current` still resolve off the bare pathname. New `admin-nav-accounts-context.test.tsx`. No schema/permission/style change.
- **ac19 — Action Launcher + Dialog Shells.** New `components/ui/dropdown-menu.tsx` (shadcn over installed `radix-ui`, zero installs); `transactions-action-bar.tsx` (`+ Payment`/`+ Note`/`More actions`, context-gated); ten dialog wrappers render each panel byte-identical inside `Dialog` (`PANEL_CLASS` strips section chrome — inv. #20 holds, panels stay standalone-renderable). 131 tests.
- **ac20 — Documents Table.** `transactions-search-params.schema.ts` (lenient `.catch()`); `documentRepository.listForContext` (CTE line-count aggregate; inv. #16 predicate admits `refBillingAccountId IS NULL`; numeric sort proxy); `list-transaction-documents.ts` (SELECT-only, inv. #15); `approval-banner.tsx`, `documents-table.tsx`; `doc-state-badge` partially-reversed chip; `pending-approvals-list.tsx` deleted. 13+18+32 tests.
- **ac21 — Document Detail Drawer.** `ledgerRepository.findTransfersByIds` (batch, replaces N+1); `get-transaction-document-detail.ts` (SELECT-only, FA ownership gate + reversal reverse-lookup); `document-detail-drawer.tsx` (server) + `document-approval-actions.tsx`; removed ac20 inline-approve stopgap. No Reject mutation exists — drawer renders Approve only. `types/accounts.ts` needs explicit `import type { Document, DocumentLine }` to shadow DOM globals. 2035 tests.
- **ac22 — Row-Level Reversal.** UI-only (inv. #18) — zero server change; contract shipped in ac11. `reversal-dialog.tsx` (`ReversalDialog` + `ReverseButton`, `stopPropagation`): fetch-on-open preview, checkboxes route subset→`reverseLine` (doc stays `posted`) vs all→`reverseDocument`, legs for checked lines only, `lastModified` CAS (CONFLICT → reload). Table/drawer gain `↺ Reverse` (hidden when ineligible, D4/D5). `reversals-panel.tsx` deleted (SC10). ac11 V4/V13 pass unmodified. 2053 tests.
### Field-mapping correction (ac24)

- **ac24 — Entry Date / Reference Date correction.** Single atomic unit (migration + schema + services + UI + tests + docs — no shippable intermediate, per ac24-spec §2.4). Migration `0022_document_rename_reference_date_to_entry_date.sql`: hand-authored `ALTER TABLE billing.document RENAME COLUMN reference_date TO entry_date` (data-preserving; not drizzle-kit generated). `event_at` untouched — still drives period validation + GL grouping (Inv. #7), now captioned **"Reference Date"** in the UI; the renamed `entry_date` (inert, defaults-to-today) is now captioned **"Entry Date"** — captions swapped to match each field's real behavior, DOM positions unchanged (ac24-spec §2.2). Schema field `referenceDate`→`entryDate` + corrected comments (`documents.ts`, `document-base.schema.ts`); 12 services + 11 write panels + `document-detail-drawer.tsx` + 16 tests renamed; 8 in-repo docs (architecture, code-standards, project-overview, ac02/ac07/ac14/ac21/ac22 specs) updated with the corrected caption mapping. `typecheck`/`format:check` green; **2097 tests pass** (all renamed executable tests, incl. every DB-integration V-test exercising `entry_date` end-to-end against migration 0022 + `billing-schema` column-existence). Grep-clean of `referenceDate`/`reference_date` in active application code (schema, services, UI, tests); migration SQL/metadata and docs describing the rename retain the old name by design.
  - *Migration meta:* followed the established post-`0017` pattern (0018–0021 are journal + SQL only, no `meta/00XX_snapshot.json`) — added the `idx: 22` journal entry, no snapshot; `db:migrate` runs off the journal, validated by the integration harness applying 0000→0022.
  - *Out of repo:* `_newmodule-account-plan.md` (ac24-spec §3.6's 9th doc) is the external canonical planning file, not present here (this repo carries mirrored copies — spec §133) — its Q9/Q29 revision-date edit could not be applied locally.
  - *v04/v13 property tests now execute (was: silently skipped).* The two `.property.test.ts` fast-check suites are DB-backed but had sat only in the default DB-free project — skipped via `describe.skipIf(!DATABASE_URL)` while the integration project's `include` (only `*.integration.test.ts`) excluded them, so they never ran, and their unguarded `afterAll` threw on the skip. Fixed by routing `tests/**/*.property.test.ts` into `vitest.integration.config.ts` `include` (and adding it to `vitest.config.ts` `exclude`), plus guarding both `afterAll`s with `if (!sql) return;` (the same pattern the passing integration V-tests use). They now run against migration 0022's `entry_date` schema alongside v03/v06/etc.

- **ac23 — Guardrail & Authz Sweep (revision).** Tests + docs only; zero application code. `route-level-transactions.test.ts` §2.2 affordance matrix (`canEdit` the single write-affordance switch); `grep-gates.test.ts` completed to 8 gates (inv. #15–#20 + §9 catalog, 49-code drift-lock); new `transactions-revision-audit.test.ts` (SC1–SC14 auditor + SC12 unmodified-V-test check). 193 tests. SC12: only 5 V-tests changed across the revision — all the sanctioned `migrate()`-poison fixture repair in `74be4fb`, no assertion changed; ac11 V4/V13 byte-unmodified.

## Deferred Items (recorded, not fixed — ac23-spec §2.7)

Carried forward explicitly so they are not mistaken for oversights. None is an ac23 defect.

1. **D1 — Account Lifecycle / `ClosurePanel` relocation.** `ClosurePanel` still renders on `/accounts/transactions` (EDIT-gated). Relocating a terminal lifecycle action out of the routine-transaction set is its own change and the next Accounts work.
2. **`INTERNAL_ERROR` single-use** in `actions/accounts/reverse-document.ts` (code-standards §9.8.1) — the sole action using this code; promote it to a documented action-boundary code or remove it, but do not copy the pattern meanwhile.
3. **Generic `NOT_FOUND` overlaps four specific codes** (`CYCLE_NOT_FOUND`, `GL_CODE_NOT_FOUND`, …) in the catalog services (code-standards §9.8.2) — new code uses the specific form; the generic remains for existing call sites only.
4. **No Reject mutation for pending documents.** ac21 found none in the codebase; the drawer renders only Approve (ac21-spec §2.4 "do not invent one"). A Reject flow, if wanted, is its own unit.
5. **Bulk row actions, saved filter views, CSV export of the documents table** — deferred (update-overview §Out of scope).

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
- **`"use client"` module exports resolve to server reference proxies when imported into a Server Component** (this Next.js build): `documents-table.tsx` exported `DOCUMENTS_PAGE_SIZE = 20` for `transactions/page.tsx` to reuse; on the server the import resolved to a proxy function (not `20`), which then serialized into the `LIMIT`/`OFFSET` SQL params and threw `invalid input syntax for type bigint`. Fixed by moving the constant into `transactions/page.tsx` itself, matching the pre-existing `TRANSFERS_PAGE_SIZE` pattern in `ledger/page.tsx` — a client component must never be the source of a value a Server Component needs by reference; duplicate/local-define constants instead.

## Resolved Open Questions (summary)

All Q1–Q28 from `_newmodule-account-plan.md` resolved. Key resolutions:
- Q1: BAN required for CRN/DBN/ADJ operations at schema level; FA-only for DEP.
- Q4: DEP panels grey until `?fa`; CRN/DBN/ADJ panels grey until both `?fa` and `?ban`.
- Q9: Absent `accounting_period` row treated as open; only an existing `state = 'closed'` row rejects a post.
- Q11: Closure-eligible when `deposits = 0` and `unapplied = 0`.
- Q16: Deposits reconcile to `sys.cash`, not a dedicated `sys.deposit_movement` account.
- Q20: Threshold routing in `submitDocument`; four-eyes docs route to `pending_approval`.
- Permission choice (ac16): `accounts_transactions:EDIT` for closure actions (operational act, not config).
