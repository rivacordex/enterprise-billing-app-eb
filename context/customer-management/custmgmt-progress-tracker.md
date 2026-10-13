# Progress Tracker

Update this file after every meaningful implementation change.

_Phase 1 (cm01–cm16, v1 full CRUD) per-unit narrative is archived in
`custmgmt-completed-tracker.md`. This file tracks the Invoice Template Binding update
(cm17–cm22). Full history: `git log -- context/customer-management/custmgmt-progress-tracker.md`;
unit plan: `context/customer-management/specs/cm00-build-plan.md`; per-unit detail:
`context/customer-management/specs/cm*.md`._

## Current state (2026-10-12)

- **Phase 1 (cm01–cm16) delivered**, ship-gated at cm16 (`8d80e6c`). Summary and
  commit table: `custmgmt-completed-tracker.md`.
- **Invoice Template Binding update (cm17–cm22) IN PROGRESS.** Scope:
  `custmgmt-update-overview.md`; rules: `custmgmt-ai-workflow-rules.md` §9. Plumbing
  only: a per-BAN invoice template reference (v1 `NULL` = follow the active template),
  captured at onboarding, reset on Manage Customer, shown on a tabbed View Customer.
  Posting ignores the reference (D4, Inv. #18).
- **cm17 SIGNED OFF** (2026-10-12) — DB-gated suite green on a disposable Postgres
  (6/6) and the `0049` → `0050` upgrade confirmed; code-review fixes landed in a cm17
  follow-up commit.
- **cm18 IN PROGRESS** — committed (`12e9c03`, SonarQube fixes `832597c`). It was
  written before cm17 passed §9.8 (§9.2 deviation, now resolved by cm17's sign-off).
  Still open: its own DB-gated suite (disposable Postgres) and the ac04 spec approval.
- **cm19 IN PROGRESS** (started 2026-10-12) — committed (`6d243f9`); code-review
  fixes committed (`1e2b91e`).
- **cm20 IN PROGRESS** (started 2026-10-12) — committed (`e44f2c7`); code-review
  fixes done, unit and DB-gated suites green, pending commit. Deviations: the loader
  placement and the review's `fa` page scope (both below).

| Unit | Name                                                        | Boundary | Status      | Commit |
| ---- | ----------------------------------------------------------- | -------- | ----------- | ------ |
| cm17 | Billing Account template reference column                   | DB       | Done        | c0b2f97 |
| cm18 | Onboarding wizard: "Invoice template" field                 | APP      | In progress | 12e9c03 |
| cm19 | View Customer: tab shell (Profile · Contacts · Accounts)    | APP      | In progress | 6d243f9 |
| cm20 | View Customer: Accounts tab                                 | APP      | In progress | e44f2c7 |
| cm21 | Manage Customer: Billing account panel + template reset     | APP      | Not started | —      |
| cm22 | Binding update ship gate: guardrails, end-to-end flow, docs | TESTS    | Not started | —      |

## Invoice Template Binding update — cm17 SIGNED OFF (2026-10-12)

- **cm17 — Billing Account template reference column (Invoice Template Binding update,
  Phase 2).** Boundary: DB. Spec:
  `context/customer-management/specs/cm17-billing-account-template-column.md`. Adds a
  nullable `billing.billing_account.ref_bill_template_version_id text` with a real FK to
  `billing.bill_template_version(bill_template_version_id)`, and mirrors it in Drizzle.
  Lands the column alone before any service reads or writes it (§9.4). No service,
  action, validator, UI, posting, index, grant or backfill change. Depends on ac02
  (`0012`) and bm50 (`0046`).
  - **Delivered:**
    - Migration `db/migrations/0050_billing_account_template_ref.sql` (+ journal idx 50,
      `when` 1791194400000): `ADD COLUMN IF NOT EXISTS`, FK
      `billing_account_ref_bill_template_version_id_fk` (47 bytes) `ON DELETE NO ACTION
      ON UPDATE NO ACTION`, column comment recording the NULL / follow-the-line /
      `generated`-only meaning.
    - `db/schema/billing/accounts.ts`: `refBillTemplateVersionId` after
      `defaultPaymentMethodRef`, plus a named `foreignKey` next to the
      `ref_financial_account_id` one. Imports `billTemplateVersion`; its import chain
      (`bill-format`, `identity`, `pg-schema`, `types/billing`, the structure schema)
      never reaches `accounts.ts`, so no cycle. `BillingAccountInsert` gets the field as
      optional, so `onboardCustomerAccounts` compiles unchanged.
    - `tests/db/billing-schema.test.ts`: column-set case updated; new case for
      nullable + named FK (via `getTableConfig(...).foreignKeys[].getName()`).
    - `tests/db/billing-account-template-column.integration.test.ts` (new, DB-gated):
      column shape (`text`, nullable, no default); FK target and name ≤ 63 bytes via
      `pg_constraint`; BAN without the column → `NULL`; `BTV99999999` → `23503`;
      seeded `BTV00000002` accepted.
  - **Deviations:** none. The integration test's schema drop list follows
    `invoice-template-catalog.integration.test.ts` (adds `partman`), not the older
    `billing-schema.integration.test.ts` list.
  - **Verification:** `tsc`, ESLint, Prettier clean. `tests/db/billing-schema.test.ts`
    and `tests/services/onboard-customer-accounts.service.test.ts` green (4 files, 93
    tests), no service code changed. `custmgmt-architecture.md` §7.3 checked: still
    accurate. No file under `services/billing/**`, `workflow-management/**` or
    `db/bootstrap/**` touched.
  - **Sign-off (2026-10-12):** the integration suite ran on a disposable Postgres and
    `0050` applied on a database already at `0049` (see the review below). The fixes
    landed in `187d8cb` after `c0b2f97`.
  - **Code review of `c0b2f97` (2026-10-12), fixes committed as the cm17 follow-up:**
    - The integration suite now migrates to the last entry before `0050`, inserts a BAN,
      then applies `0050`. It covers the upgrade path and checks that the pre-existing BAN
      reads `NULL`. The FK case also checks the owning table and column and `NO ACTION`
      (`confdeltype`/`confupdtype` = `a`), not only the target table. `afterAll` is guarded
      and has a 60 s timeout. The unit FK case asserts the columns and the target table,
      not only the name.
    - Ran green (6/6) on a throwaway Postgres container (`enterprise-billing-app-db`
      image, marked disposable, not the dev stack). A manual 0049 → 0050 upgrade also
      passed. `tsc` is clean, and `billing-schema.test.ts` is green.
    - Restored `context/billing-management/invoice-template/placeholder-catalog.md`,
      which `c0b2f97` deleted while it is still cited as authoritative by
      `billmgmt-ai-workflow-rules.md`, `billmgmt-code-standards.md`, `types/billing.ts`
      and `validation/billing/invoice-profile.schema.ts`. Billing docs are read-only in
      this update (§9.6 item 7).
    - Raised, not changed: no draft of the `acctmgmt-architecture.md` `billing_account`
      row change has been recorded yet (§9.7 item 6). The billing tracker compaction
      that shipped inside `c0b2f97` sits outside cm17's planned files.

## Invoice Template Binding update — cm18 IN PROGRESS (started 2026-10-12)

- **cm18 — Onboarding wizard "Invoice template" field.** Boundary: APP. Spec:
  `context/customer-management/specs/cm18-onboarding-invoice-template-field.md`.
  Authorized by D2, D11, D13, D15, Inv. #18. Depends on cm17.
  - **Delivered:**
    - `services/accounts/assert-bindable-template.ts` (new): v1 rule only, `null` → ok,
      any string → `TEMPLATE_NOT_BINDABLE`; takes `tx` for the Phase 3 signature, no
      DB call.
    - `validation/accounts/onboard-customer-accounts.schema.ts`: optional nullable
      `billTemplateVersionId` (`/^BTV\d{8}$/`).
    - `services/accounts/onboard-customer-accounts.ts`: validator runs inside the
      transaction after the cycle check, before `compareAndUpdateStatus`; BAN insert and
      `ACCOUNTS_ONBOARDED.afterData` carry `refBillTemplateVersionId` (always `null`).
      New result code `TEMPLATE_NOT_BINDABLE`; also added to the action result type.
      Guards unchanged.
    - `components/customers/onboard-accounts-wizard.tsx`: read-only "Invoice template —
      Follow active template" field after Currency (same styling) with
      `FieldDescription` help text (O1); submits `billTemplateVersionId: null`;
      `TEMPLATE_NOT_BINDABLE` case in the result switch.
    - Tests: `tests/services/assert-bindable-template.test.ts`,
      `tests/validation/onboard-customer-accounts.schema.test.ts`,
      `tests/components/onboard-accounts-wizard.test.tsx` (all new);
      `tests/services/onboard-customer-accounts.service.test.ts` (+4 cases);
      `tests/accounts/onboard-customer-accounts-template.integration.test.ts` (new,
      DB-gated, v07 fresh-migrate setup, drop list incl. `partman`).
  - **Deviations:** none.
  - **Verification:** `tsc`, ESLint, Prettier clean. 4 unit/component files green (29
    tests) under `--pool=threads` (forks pool times out on this machine). No change to
    `services/billing/**`, `workflow-management/**`, `getWizardOptions`,
    `customer-role-form.tsx` or the customer section components. The only
    `refBillTemplateVersionId` hit under `services/billing/**` is bm54's
    `customer_bill` stamp in `resolve-template.ts`, not the `billing_account` column.
    `custmgmt-architecture.md` §7.2/§7.4 checked: still accurate.
  - **OPEN, blocking cm18 sign-off:** (1) run the new integration test and the V7 test
    on a disposable Postgres; (2) the `ac04` onboarding spec change (new input field,
    result code, `afterData` key) is drafted and needs approval before editing (§9.7
    item 6). Then commit and record the hash above.

## Invoice Template Binding update — cm19 IN PROGRESS (started 2026-10-12)

- **cm19 — View Customer tab shell (Profile · Contacts · Accounts).** Boundary: APP.
  Spec: `context/customer-management/specs/cm19-view-customer-tab-shell.md`. Authorized
  by binding plan §7.1, D5, Inv. #14. Depends on cm05 only.
  - **Delivered:**
    - `validation/customer/search-params.schema.ts`: `CUSTOMER_DETAIL_TABS`,
      `CustomerDetailTab`, `customerDetailSearchParamsSchema` (lenient,
      `.catch("profile")`).
    - `components/customers/customer-detail-tabs.tsx` (new): server component,
      `<nav aria-label="Customer detail tabs">` of plain `<Link href="?tab=…">` with
      `aria-current="page"`, classes copied from `run-detail-tabs.tsx`.
    - `app/(app)/customers/view/[id]/page.tsx`: takes `searchParams`, parses `tab` via
      `firstValue` after the not-found check; header → banner → tab strip → active
      panel. Profile = Organization + Customer Role; Contacts = Contact Details;
      Accounts = empty `<div aria-label="Accounts" />` (cm20 fills it).
    - Tests: `tests/app/customers-view-detail-page.test.tsx` (rewritten: guard,
      no-access, malformed/unknown id without strip, default/contacts/accounts,
      bogus + array fallback, banner above strip on all three tabs / absent for
      ordinary pair); `tests/components/customer-detail-tabs.test.tsx` and
      `tests/validation/customer-search-params.schema.test.ts` (new).
    - Docs: `custmgmt-code-standards.md` §4 item 5 + §7 tree (`CustomerDetailTabs`,
      `search-params.schema.ts`); `custmgmt-project-overview.md` core flow step 10 +
      *Features*; `cm05.md` superseded-layout note.
  - **Deviations:** none. Section components, `CustomerNotFound`, `metadata.title`,
    `getCustomerDetail`, the nav registry and `components/ui/**` are unchanged; no
    `"use client"` added.
  - **Verification:** `tsc`, ESLint, Prettier clean. 3 cm19 test files (+1 matched by
    the filter) green, 31 tests, under `--pool=threads --maxWorkers=1` (the default
    worker count timed out at startup while `tsc` was running in parallel).
  - **Committed** as `6d243f9`.
  - **Code review of `6d243f9` (2026-10-13), fixes in the working tree:**
    - `CustomerDetailTabs` links gain the §9.1 keyboard focus ring
      (`focus-visible:[box-shadow:var(--focus-ring)]`); the copied run-detail classes
      had none.
    - The Accounts panel is a `<section aria-label="Accounts">` (region) instead of a
      `<div>`: ARIA prohibits `aria-label` on a generic element, so the name was never
      exposed. The page test now asserts the region on `?tab=accounts`.
    - The per-tab `it.each` cases iterate `CUSTOMER_DETAIL_TABS`, so the
      banner-on-every-tab check (Inv. #14) covers any tab added later.
    - Reported, not changed: the tab-strip markup is now the fourth verbatim copy
      (bill-run list, run detail, invoice settings); every tab still loads the full
      `getCustomerDetail` (protected file, §9.6 item 3).
  - **OPEN:** commit the review fixes. No DB-gated work in this unit.

## Invoice Template Binding update — cm20 IN PROGRESS (started 2026-10-12)

- **cm20 — View Customer: Accounts tab.** Boundary: APP. Spec:
  `context/customer-management/specs/cm20-view-customer-accounts-tab.md`. Authorized
  by binding plan §7.2, D6, D7, D8, D11, D14, D16; Inv. #11, #12, #13, #15, #18.
  Depends on cm19 (tab shell) and cm17 (column).
  - **Delivered:**
    - `types/accounts.ts`: `CustomerAccountsSummary` (not-onboarded / onboarded).
    - `db/repositories/accounts/ledger.repository.ts`:
      `receivablesByFinancialAccount` (per-BAN receivables, one grouped statement;
      unbound BANs absent → caller defaults `"0.00"`).
    - `services/accounts/resolve-ban-template-label.ts` (new):
      `resolveCurrentTemplateLabel` (`findActive ?? findDefault`, kind `generated`, layout
      code + `vN`) and `banTemplateLabel` (`NULL` → "Follows active template
      (currently: …), as of now"; non-`NULL` → "Template reference not supported yet").
      It never calls `resolveTemplate` or `resolveVersionsForPosting`.
    - `services/accounts/get-customer-accounts-summary.ts` (new):
      `getCustomerAccountsSummary(partyRoleId, page)`. FA by party-role key;
      `getFinancialAccountDetail`, BAN rows, the grouped receivables read and one
      `listTransactionDocuments` page per FA, run in parallel; one cycle read per
      distinct cycle; `resolveTerm` for the term; `logger.warn` on a non-`NULL` template
      ref. `resolveDocumentsPageSize`: missing / non-numeric / `< 1` → 20, capped at 100.
    - `db/seeds/customer.ts`: idempotent `CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE` = `20`
      (group `customer`).
    - `components/customers/` (new): `customer-accounts-tab.tsx`,
      `accounts-locked-card.tsx`, `accounts-not-onboarded-card.tsx`,
      `financial-account-summary-card.tsx`, `billing-account-card.tsx` (template label
      per ui-context §9.4), `ban-state-chip.tsx`, `customer-documents-table.tsx`
      (read-only; rows link to `/accounts/transactions?party=…&fa=…&doc=…`;
      Previous/Next keep `tab=accounts`), `accounts-tab-skeleton.tsx`.
    - `validation/customer/search-params.schema.ts`: lenient `page`
      (`.min(1).max(9999).catch(1)`).
    - `app/(app)/customers/view/[id]/page.tsx`: `canViewAccounts` from the guard's
      `permissionMap`. On `tab=accounts` it renders either `AccountsLockedCard` (no query)
      or `<Suspense fallback={<AccountsTabSkeleton />}>` around an in-page async loader.
    - Tests: `tests/services/get-customer-accounts-summary.test.ts`,
      `tests/services/resolve-ban-template-label.test.ts`,
      `tests/components/customer-accounts-tab.test.tsx` (all new);
      `tests/app/customers-view-detail-page.test.tsx` (+4 cases; async server
      components resolved in-tree before render);
      `tests/validation/customer-search-params.schema.test.ts` (expects `page: 1`, plus
      page cases); `tests/accounts/get-customer-accounts-summary.integration.test.ts`
      (new, DB-gated).
    - Docs (§3.9): `custmgmt-architecture.md` Inv. #15 + §7 storage row and
      `custmgmt-update-overview.md` Accounts-tab feature now describe the real balance
      source. `custmgmt-code-standards.md` §4 item 5 (components), §6 item 10 (config
      key), §7 tree and §8 (Accounts tab sub-gate). `cm00-build-plan.md` cm20 "Builds"
      already named the seed, so no change was needed. The binding plan (D16, §7.2) is
      not in the repo, so its wording was not edited.
  - **Deviation (spec §3.6/§3.7):** `CustomerAccountsTab` cannot call the service as
    specified, because the ESLint `boundaries` rule forbids `components/**` →
    `services/**`. The async fetch is a non-exported `CustomerAccountsTabLoader` in
    `page.tsx`. `CustomerAccountsTab` stays in `components/customers/` as a
    presentational component taking `summary`. The page renders the locked card
    directly, so the component has no `canViewAccounts` prop. Behaviour is unchanged:
    the permission is checked once, the fetch happens only on `tab=accounts` under
    Suspense, and the service is never called when locked.
  - **Verification:** `tsc`, ESLint, Prettier clean. Unit, component and page files
    green, run one file at a time under `--pool=threads --maxWorkers=1`: summary 16,
    label 4, accounts tab 9, schema 11, tabs 4, page 26. The DB-gated suite passed 5/5
    on a throwaway `enterprise-billing-app-db` container (port 15433, marked
    disposable, not the dev stack), then the container was stopped. Import grep over
    the new files: no `actions/**`, `post-document`, `reversal-dialog`,
    Accounts `documents-table`, `resolveTemplate` or `resolveVersionsForPosting`.
    Guardrails green: `customer-module-boundaries`, `verification-audit`,
    `status-literal-sweep`, `invoice-render-source-boundary`, `route-manifest`,
    `nav-registry-guard`.
  - **Baseline failure, reported and not fixed (billmgmt known-issues §21):**
    `tests/accounts/grep-gates.test.ts`, 2 cases. cm18's `TEMPLATE_NOT_BINDABLE` is
    missing from the Accounts code-standards §9 Result-code catalog (51 codes). Fixing it
    means an Accounts doc edit, which belongs with the pending ac04/cm18 approval
    (§9.7 item 6).
  - **Code review of `e44f2c7` (2026-10-13), fixes pending commit:**
    - **Document links vs. permission.** Rows link to `/accounts/transactions`, which
      is guarded by `accounts_transactions : READ`. The page now checks that too
      (`canOpenDocuments`) and passes it down; without it, document ids render as
      plain text instead of links to `/no-access`.
    - **Failure stays in the tab.** `CustomerAccountsTabLoader` catches a failed
      summary read (`unstable_rethrow` first, then `reportError`) and renders the new
      `AccountsUnavailableCard` (`role="alert"`). The header, tab strip and other
      tabs survive, rather than `customers/view/error.tsx` replacing the page.
    - **Out-of-range page clamped.** The service re-reads at the last page when the
      requested page is past the end, and returns the effective page. That costs a
      second document read only in that case.
    - **Per-FA paging (deviation from spec §3.4 `?tab=accounts&page=N`).** New
      lenient `fa` search param (`/^FINd+$/`, else `null`). `page` applies only to
      the named FA, and the other FAs show page 1. With no `fa`, `page` applies to
      every FA, so the spec's `?tab=accounts&page=N` links still work. Pagination
      links now carry `fa`; each nav is labelled `Documents pagination for <FIN>`.
    - **BAN currency.** The summary carries each BAN's own `currency`, and the BAN card
      formats its receivable with it, not with the FA's.
    - **One snapshot for receivables.** The FA receivable is now
      `money.sum` of the per-BAN values the cards show, so the total always equals the
      sum of the cards. `getFinancialAccountDetail` still supplies unapplied cash and
      deposits.
    - **FA state shown.** The FA card has the account-state chip (reused
      `BanStateChip`) and mutes when closed. FA and BAN `state` are typed
      `AccountState`.
    - **Pending feedback.** The Suspense boundary is keyed by `fa:page`, so
      Previous/Next shows the skeleton.
    - **Inv. #11 guardrail.** New `tests/guardrails/customer-accounts-read-boundary.test.ts`
      scans `app/(app)/customers/**` and `components/customers/**` for static,
      side-effect, dynamic and `require` imports, after normalising `@/` and relative
      paths. It forbids `post-document`, pgledger, the ledger repository, the Accounts
      reversal UI, `actions/billing/**`, the posting resolver, and `actions/accounts/**`
      except an allowlist: the onboarding wizard's two ac04/cm18 actions. cm21 adds its
      reset action there. A self-test proves the extractor handles each import form.
    - **Tests.** Service (+6: clamp, in-range single read, empty → page 1, per-FA
      page, summed receivable, BAN currency), accounts tab (plain ids without the
      permission, FA chip/mute, BAN currency, `fa`-scoped links), page (`fa` passed
      through, failure stays in the tab, links follow `accounts_transactions`),
      schema (`fa` parse/fallback), integration (+1: page 9 → clamped to 2).
    - **Verification.** `tsc`, ESLint and Prettier are clean. The 6 affected unit,
      component and guardrail files are green under `--pool=threads --maxWorkers=1`.
      The DB-gated summary suite passed 6/6 on a throwaway
      `enterprise-billing-app-db` container (port 55433, marked disposable, not the
      dev stack), which was then removed.
    - **Raised, not changed:** the template-label format (Open questions); and
      cleanup items left for later: a shared positive-int config parser (4 copies),
      one shared account-state chip with the Accounts Overview, a structured template
      label instead of the card's regex split, unused reads in
      `getFinancialAccountDetail` / serial `findActive`→`findDefault`, and the
      redundant BAN re-sort.
  - **OPEN:** commit the review fixes. The seed itself was not run (the service falls
    back to 20 when the key is absent).

## Outstanding / Next

- **cm17:** signed off (`c0b2f97` + review follow-up `187d8cb`).
- **cm18:** DB-gated run + ac04 spec approval above.
- **cm19:** committed (`6d243f9`, review fixes `1e2b91e`).
- **cm20:** committed (`e44f2c7`); commit the code-review fixes. The `grep-gates` Result-code failure (cm18's
  `TEMPLATE_NOT_BINDABLE`) is resolved with the ac04/cm18 Accounts doc approval.
- **cm21 next** (Manage Customer Billing account panel; depends on cm20).

## Key decisions (durable)

- **cm17 — column shape (D9/D10).** Nullable, no default, no backfill; `NULL` = follow
  the current ACTIVE template, else the default. The stored type is a version id for
  referential integrity, but the meaning is "follow the template line", kind
  `generated` only. No `CHECK` on kind: the kind rule lives in `assertBindableTemplate`
  (cm18).
- **cm17 — FK `ON DELETE NO ACTION`.** Template versions are never deleted
  (`bill_template_version_guard`, bm50), so cascade / set-null would be dead code.
- **cm17 — no index, no grant change.** Nothing filters or joins on the column in v1;
  add an index in Phase 3 if posting starts joining on it. Existing table-level grants
  already cover `app_runtime`; `billrun_runtime` / `rating_runtime` can read it but
  never do (Inv. #18).
- **Tracker split.** `custmgmt-completed-tracker.md` is the Phase 1 archive; this file
  is the live tracker every spec's checklist refers to (same split as billing).

## Open questions

- **cm20 template label format (spec issue, raised by the `e44f2c7` review).** The
  label joins the *layout* code with the *generated* version's number (e.g.
  "INVTPL-STD-A4 v2" after generated v2 is activated on layout v1). Billing settings
  uses "CODE vN" for layout versions, so this can name a layout version that does not
  exist. That works against Inv. #18 (never imply a binding the invoice does not use).
  The spec mandates the current format, so it is unchanged. Decide the wording before
  cm21 reuses the label.
