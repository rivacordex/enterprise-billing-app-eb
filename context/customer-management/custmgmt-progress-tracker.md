# Customer Management — Completed Tracker

Archive of delivered work for the Customer Management module. Single tracker since 2026-10-15: `custmgmt-progress-tracker.md` was merged in and removed. Per-unit narrative, review-fix logs and test enumerations are trimmed to key facts and decisions. Full history: `git log -- context/customer-management/custmgmt-progress-tracker.md` (the 542-line pre-archive Phase 2 narrative is at `185455e^`). Per-unit detail: `context/customer-management/specs/cm*.md`.

## Phases

| Phase | Units     | Scope                           | Ship gate                                  | Status                 |
| ----- | --------- | ------------------------------- | ------------------------------------------ | ---------------------- |
| 1     | cm01–cm16 | v1 full CRUD                    | cm16 (`8d80e6c`)                           | Completed (2026-07-17) |
| 2     | cm17–cm22 | Invoice Template Binding update | cm22 (`e46ee32`, tightening `a3f2923`)     | Completed (2026-10-14) |
| 3     | cm23–cm24 | Invoice Template Types update (bind a BAN to a template type) | cm24 (joint with Billing bm85) | In progress (cm23 started 2026-10-26) |

---

# Phase 3 — Invoice Template Types update (cm23–cm24) — IN PROGRESS

Bind a BAN to a template **type** (`billing.billing_account.ref_bill_template_family_id`, `NULL` = Standard). Scope: `custmgmt-update-overview.md`; rules: `custmgmt-ai-workflow-rules.md` §10, `custmgmt-code-standards.md` §10. Owning update: Billing (bm74–bm85).

| Unit | Name                                                                                         | Boundary | Status          |
| ---- | -------------------------------------------------------------------------------------------- | -------- | --------------- |
| cm23 | Bind a BAN to a template type (`0054`, type-aware gate, panel select + Save, type labels, onboarding wording). **One merge with Billing bm82** | APP      | **Built** (2026-10-26), with Billing bm82 in the same merge |
| cm24 | Ship gate pointer, joint with Billing bm85                                                   | TESTS    | Not started     |

**cm23 notes (2026-10-26):**

- **Built as specified:**
  - `0054_billing_account_template_type.sql`: adds the column, FK and comment; raises `MIGRATION_PRECONDITION` on any non-NULL version value; then drops the old column and FK. Journal idx 54.
  - The Drizzle mirror and `setTemplateRef` move to `refBillTemplateFamilyId`.
  - `assertBindableTemplate` takes `lockTemplateType(tx, id, "share")`, then checks `isDefault`, retired and `findActive`.
  - `setBillingAccountTemplate`: `typeId`, and audit `{ refBillTemplateFamilyId, typeName }`.
  - Onboarding: `templateTypeId: z.null().optional()`, always NULL.
  - New `listBindableTemplateTypes` and `resolveBanTemplateLabels` (one read per distinct type, both read services call it once, warn removed).
  - `STANDARD_TYPE_NAME`, `BindableTemplateType` and `BanTemplateLabel` live in `types/accounts.ts`.
  - UI: `billing-account-messages.ts`, `TemplateTypeSelect` (`__standard__` sentinel, "Choose a type" placeholder), the panel select + Save with the next-run caption, the structured `TemplateLabel` (mono `v{N}`, warning icon for `NOT_USABLE`) and the onboarding wording.
- **Small additions:**
  - `templateLabelFor(labels, typeId)` is exported beside `resolveBanTemplateLabels`, a map lookup shared by both read services.
  - `GENERIC_FAILURE` moved into `billing-account-messages.ts` with the other copy.
  - The panel keeps per-BAN selections in one map and clears a BAN's entry on success and on `TEMPLATE_NOT_BINDABLE`, so the reload shows the BAN's current type.
  - The manage page runs the two panel reads together inside `loadBillingAccounts`, which still sits in the page's `Promise.all`.
  - Test helper `tests/helpers/bindable-template-type.ts` creates and retires types through SQL.
  - `customer-accounts-read-boundary` allowlists the messages file's type-only action import.
- **Guardrail 11:** the "no `ref_bill_template_version_id` on `billing_account`" check matches the column only next to `billing_account`, because `customer_bill`, `bill_run_account` and `bill_template_version` keep a column of the same name.
- **Tests:**
  - tsc and ESLint clean, Prettier applied.
  - Unit (services, actions, validation): 87/0.
  - Component, app and guardrail: 105/1.
  - DB-gated on the disposable `ebill-test` DB: 26/0 across 7 files. Covers bind, onboarding template, summary, the journey, the column and the new `0054` migration suite; V7 atomicity is green, unedited.
- **bm82 landed (2026-10-26):** capture reads the type column, the Billing fixtures moved to `ref_bill_template_family_id`; guardrail 11 is green (11/11) and the capture/trigger suites pass.
- **Not edited (approval needed):** `ac04` (Accounts spec) still quotes the old wizard wording. acctmgmt docs need owner approval (workflow rules §10.6 item 5).

## Carried forward (not blocking)

- **Template label format (cm20).** The label joins the *layout* code with the *generated* version number (e.g. "INVTPL-STD-A4 v2"), which can name a layout version that does not exist — in tension with Inv. #18. Kept as the spec mandates; decide the wording before Phase 3.
- **`EDIT_DISABLED_TITLE` copy (cm21).** Reads "accounts configuration edit access" but the panel gates on `accounts_transactions`; used unchanged per spec.
- **Binding plan §11 matrix.** The source plan (`_updatemodule-…-binding-plan.md`) is not in the repo, so §11 was not checked row by row; §12 O1/O3/O4 were closed in `custmgmt-architecture.md` / workflow rules §9.5 instead.
- **Baseline test failures** (billmgmt known-issues §21, fix as their own change): 7 unit files fail to load without env (`lib/config`: `manage-products-*` ×3, `company-profile-form`, `run-detail-tabs`, `selection-region`, `trigger-run.service`); `ratecard-parse-csv` and `pricing-component-guardrails` #31 time out because their repo scans walk the stale `.claude/worktrees/` copies (skip `.claude` or remove the worktrees).
- **cm22 guardrail check 4** can approach its 30 s timeout under heavy machine load (~3.5 s idle).
- **Cleanup candidates (cm19/cm20 reviews):** fourth verbatim copy of the tab-strip markup (bill-run list, run detail, invoice settings); every tab still loads the full `getCustomerDetail`; shared positive-int config parser (4 copies); one shared account-state chip with Accounts Overview; structured template label instead of the card's regex split; unused reads in `getFinancialAccountDetail` and serial `findActive` → `findDefault`; redundant BAN re-sort.
- **`CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE` seed** was never run on its own; the service falls back to 20 when the key is absent.

---

# Phase 2 — Invoice Template Binding update (cm17–cm22) — COMPLETED 2026-10-14

Plumbing only: a per-BAN invoice template reference (`billing.billing_account.ref_bill_template_version_id`, v1 always `NULL` = follow the active template), captured at onboarding, reset on Manage Customer, shown on a tabbed View Customer. Posting never reads it (D4, Inv. #18). Scope: `custmgmt-update-overview.md`; rules: `custmgmt-ai-workflow-rules.md` §9.

| Unit | Name                                                        | Boundary | Commit    | Review / follow-up fixes                 |
| ---- | ----------------------------------------------------------- | -------- | --------- | ---------------------------------------- |
| cm17 | Billing Account template reference column                   | DB       | `c0b2f97` | `832597c`, `187d8cb`, `7508edb`          |
| cm18 | Onboarding wizard: "Invoice template" field                 | APP      | `12e9c03` | `832597c`, `7508edb`                     |
| cm19 | View Customer: tab shell (Profile · Contacts · Accounts)    | APP      | `6d243f9` | `1e2b91e`                                |
| cm20 | View Customer: Accounts tab                                 | APP      | `e44f2c7` | `9eb25e8`                                |
| cm21 | Manage Customer: Billing account panel + template reset     | APP      | `e2677bf` | `a329ff4`, `018f8a3` (Accounts arch doc) |
| cm22 | Binding update ship gate: guardrails, end-to-end flow, docs | TESTS    | `e46ee32` | `a3f2923` (guardrail tightening)         |

## Phase 2 per-unit notes

**cm17** — Migration `0050_billing_account_template_ref.sql`: nullable `text` column, named FK `billing_account_ref_bill_template_version_id_fk` → `bill_template_version` (`NO ACTION`), column comment; Drizzle mirror in `db/schema/billing/accounts.ts` (optional on `BillingAccountInsert`, so onboarding compiled unchanged). No index, grant or backfill. DB-gated suite (6/6) covers the `0049` → `0050` upgrade with a pre-existing BAN reading `NULL`. Review restored `billing-management/invoice-template/placeholder-catalog.md`, which `c0b2f97` had deleted.

**cm18** — `assertBindableTemplate` (v1: `null` ok, any string → `TEMPLATE_NOT_BINDABLE`; takes `tx` for the Phase 3 signature, no DB call). Optional `billTemplateVersionId` (`/^BTV\d{8}$/`) on the onboarding schema; validator runs inside the onboarding transaction after the cycle check; BAN insert and `ACCOUNTS_ONBOARDED.afterData` carry the ref. Read-only "Invoice template — Follow active template" wizard field after Currency. ac04 spec amended (user-approved, applied in cm22).

**cm19** — `?tab=profile|contacts|accounts` (lenient, falls back to `profile`) on `/customers/view/[id]`; server-rendered `CustomerDetailTabs` link strip (`aria-current`, §9.1 focus ring); Accounts panel is a `<section aria-label>` region; inconsistency banner above the strip on every tab (Inv. #14), tested over `CUSTOMER_DETAIL_TABS`.

**cm20** — Accounts tab: `getCustomerAccountsSummary` (FA + BANs + per-BAN receivables via one grouped `receivablesByFinancialAccount` read + paged documents), `resolveCurrentTemplateLabel` / `banTemplateLabel` (never calls the posting resolver), `CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE` seed (default 20, max 100). Gated by `accounts_*` permissions; document links require `accounts_transactions : READ` (else plain ids); failures stay inside the tab (`AccountsUnavailableCard`). Review: out-of-range page clamped to the last page; FA receivable = sum of the BAN cards; each BAN formatted in its own currency; FA state chip. **Deviations:** the async loader lives in `page.tsx` (ESLint `boundaries` forbids `components/**` → `services/**`); per-FA paging via a lenient `fa` param (no `fa` → `page` applies to every FA, so spec links still work). New guardrail `customer-accounts-read-boundary.test.ts` (Inv. #11).

**cm21** — `setBillingAccountTemplate` (CAS on the BAN's own `last_modified`, `state <> 'closed'`; `party_role` never read or bumped; unchanged value → no write/audit; BAN of another party role → `BAN_NOT_FOUND`), new audit type `BILLING_ACCOUNT_TEMPLATE_CHANGED` (category Change), dual-permission action (`customers : EDIT` + `accounts_transactions : EDIT`), `listCustomerBillingAccounts`, `BillingAccountPanel` on Manage Customer. `VALIDATION_ERROR` shows the module's generic error copy (none spec'd). Accounts docs updated with user approval: `acctmgmt-code-standards.md` §9 result-code catalog 51 → 54 (`TEMPLATE_NOT_BINDABLE`, `BAN_CLOSED`, `BAN_NOT_FOUND`) and the `acctmgmt-architecture.md` `billing_account` row.

**cm22** — Ship gate (tests + docs, no product code). `customer-accounts-binding-boundaries.test.ts` (5 checks: customer screens import only the two read services and no `db/repositories/{accounts,billing}/**`; read services make no writes; posting never reads the BAN column; `assertBindableTemplate` used only by onboarding + reset; the column written only by onboarding and `setTemplateRef`, with hidden-column-list BAN writes reported). `customer-accounts-journey.integration.test.ts` (8-step E2E). ac04 / ac23 Accounts spec edits applied (user-approved). Module docs (architecture, code standards, project overview, update overview, cm05) aligned with the code. **Deviations:** check 1 also allowlists `get-wizard-options` (a read); check 3 uses the file-level rule with two named exemptions (`customer-bill.repository.ts`, `invoice-render-input.ts`, which read `customer_bill`'s stamp).

**Final verification (cm22, 2026-10-13):** full integration project 131 files / 1213 tests, 0 failed; full unit suite 4474 passed; posting-invariance suites (`customer-bill-stamps`, `invoice-default-resolution`, `invoice-version-pinning`, bm13/bm19 e2e) green on a disposable Postgres + Azurite. Baseline failures reported, not fixed (see Carried forward).

## Phase 2 key decisions

- **Column shape (D9/D10).** Nullable, no default, no backfill; `NULL` = follow the current ACTIVE template, else the default. Stored as a version id for referential integrity; meaning is "follow the template line", kind `generated` only. Kind rule lives in `assertBindableTemplate`, not a `CHECK`.
- **FK `ON DELETE NO ACTION`.** Template versions are never deleted (`bill_template_version_guard`, bm50).
- **No index, no grant change.** Nothing filters or joins on the column in v1; add an index in Phase 3 if posting joins on it. `billrun_runtime` / `rating_runtime` can read it but never do (Inv. #18).
- **Reset is BAN-scoped.** CAS on the BAN's `last_modified`; the customer's `party_role` lock is not involved.

---

# Phase 1 — v1 full CRUD (cm01–cm16) — COMPLETED 2026-07-17

All 16 units committed; ship-gate-verified (cm16) at the DB/test level. SAST/DAST and live-browser sign-off are CI/manual steps outside this tooling.

| Unit | Name                                                                    | Commit                | Spec            |
| ---- | ----------------------------------------------------------------------- | --------------------- | --------------- |
| cm01 | DB foundation (`customer` schema, migration, seed, permission registry) | `4426342`             | `specs/cm01.md` |
| cm02 | Validation schemas + read repositories + read services                  | `3347d04`             | `specs/cm02.md` |
| cm03 | Nav ("Customer" `NAV_SECTIONS` entry + locked-item `AdminNav` state)    | `47c0f68`             | `specs/cm03.md` |
| cm04 | View search page                                                        | `d37c875`             | `specs/cm04.md` |
| cm05 | View detail page                                                        | `b1d0d8a`             | `specs/cm05.md` |
| cm06 | Manage search page                                                      | `53f9a62`             | `specs/cm06.md` |
| cm07 | Create customer                                                         | `9665074`             | `specs/cm07.md` |
| cm08 | Edit page + update organization                                         | `ff2dbc4`             | `specs/cm08.md` |
| cm09 | Transition organization status                                          | `9aae48c`             | `specs/cm09.md` |
| cm10 | Transition customer status                                              | `00a865a`             | `specs/cm10.md` |
| cm11 | Add contact                                                             | `0d80df8`             | `specs/cm11.md` |
| cm12 | Update contact                                                          | `12240ce` (with cm11) | `specs/cm12.md` |
| cm13 | Delete contact                                                          | `a8e22ff`             | `specs/cm13.md` |
| cm14 | Set preferred contact                                                   | `2e505cb`             | `specs/cm14.md` |
| cm15 | Set preferred contact method                                            | `b349cf7`             | `specs/cm15-set-preferred-contact-method.md` |
| cm16 | Authz guardrail sweep (ship gate)                                       | `8d80e6c`             | `specs/cm16-authz-guardrail-sweep.md` |

Review fixes for cm11–cm16: `15a3220`.

## Recurring patterns (not repeated per unit)

- **Audit event type ripple:** a new `AUDIT_EVENT_TYPES` entry (cm07–cm13, cm15, cm21) needs `types/audit-log.ts`'s `AUDIT_EVENT_CATEGORY_MAP` (`tsc`-caught) and the counts/optgroups in `tests/components/audit-log-filters.test.tsx` (**not** `tsc`-caught). See `[[audit-event-type-addition-ripple]]`.
- **Route manifest ripple:** every new `app/**/page.tsx` must be added to `tests/app/route-manifest.test.ts`'s frozen `ROUTE_MANIFEST`.
- **Mutation shape (cm07–cm15):** action → service → repository; guard → `safeParse` → one service call → `revalidatePath`; services run `compareAndBumpLock` (cm08) first inside a transaction, short-circuiting to `CONFLICT` before any write/audit.
- **`db` import convention:** services import the `db` singleton (cm02's `db`-as-parameter shape was a bug, fixed in cm04).
- **Integration DB:** Phase 1 ran against the local dev container (with user confirmation; re-provision with `down -v && up -d --build`). Phase 2 used a disposable Postgres (billmgmt known-issues §13).

## Phase 1 per-unit notes

- **cm01** — `customer` schema (`organization`/`party_role`/`contact_medium`, 3 sequences, all constraints), `0009_customer.sql`, seed (`customers` permission, `CUSTOMER_SEARCH_RESULT_LIMIT`), `types/customer.ts`. Composite deferrable FK hand-authored in SQL. Later fix: seed grants `ADMIN → customers:EDIT`.
- **cm02** — Validation schemas, three finder-only repositories, `searchCustomers`/`getCustomerDetail`, keyed by `party_role_id`.
- **cm03** — "Customer" nav entry + `AdminNav` locked/greyed items (fails closed without `permissionMap`); `getCurrentUserIdentity` exposes `userId` (beyond the spec's file list).
- **cm04** — `/customers/view`: READ guard, `q`-only search, results table, status badges.
- **cm05** — `/customers/view/[id]`: read-only sections + `InconsistencyBanner` (`isStatusInconsistent`: ACTIVE customer + non-ACTIVE org; DISSOLVED/MERGED org + non-CLOSED customer). Semantic CSS token aliases; Tailwind arbitrary values instead of inline `style`.
- **cm06** — `/customers/manage`: EDIT guard, reuses cm04's search, "Add new customer" CTA.
- **cm07** — `create-customer`: two-step similar-name confirm, one transaction (org → audit → party_role → audit), `isUniqueViolation` checks `err.cause` (Drizzle wraps `PostgresError` in `DrizzleQueryError`).
- **cm08** — `compareAndBumpLock` (CAS on `party_role.last_modified_datetime`, Inv. #6); field-only `organizationRepository.update`; edit-page container.
- **cm09** — `StatusTransitionControl`; transition validity checked against `ORGANIZATION_TRANSITIONS` before the transaction.
- **cm10** — Same control for the customer; `compareAndUpdateStatus`/`compareAndUpdateSpecification`; `CustomerRoleForm`; folds in `update-party-role-specification`.
- **cm11** — First contact mutation; Inv. #4 (first contact auto-preferred) and Inv. #5 (`resolvePreferredMethod`, PHONE → EMAIL → ADDRESS); `ContactManagerPanel`.
- **cm12** — `resolveUpdatedPreferredMethod` (auto-assign / untouched / `PREFERRED_METHOD_STILL_POPULATED` / clear-to-zero allowed); shared `ContactFieldsFieldset`.
- **cm13** — The one physical delete: `CONTACT_NOT_FOUND` / `CANNOT_DELETE_PREFERRED_CONTACT`; audit `afterData: null`; structural test pins `deleteById` callers; `AlertDialog` confirm.
- **cm14** — `setPreferredContact` (escape hatch for cm13's blocked delete); same-contact reassignment not special-cased.
- **cm15** — `setPreferredContactMethod` among populated methods; spec typo fixed (`gaAddressLine1`); distinct `aria-label`s vs cm14's button.
- **cm16** — Tests-only ship gate: route × level matrix, Server Action USER-denial for all 10 actions, `customer-core-flow` E2E, `customer-module-boundaries` (6 checks), `customer-audit-completeness`. Fixed doc gaps (code-standards §7 missing an action; architecture route typo); spec worked examples corrected to the real transition maps.

**Final verification (cm16):** unit 155 files / 1408 tests; integration 37 files / 327 tests, all green.

## Phase 1 architecture decisions

- Soft delete only via status (Organization → DISSOLVED, Customer → CLOSED); no physical deletes except contact rows.
- `contact_medium` is flattened (one row per contact, inline phone/email/address).
- Preferred contact and preferred method are enforced in the database (composite deferrable FK / constraints).
- Reuses the platform as-is: better-auth RBAC (USER/MANAGER), `system_config`, pg_partman audit schema, User/Product Management conventions.
