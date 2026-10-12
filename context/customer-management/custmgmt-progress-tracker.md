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
- **cm17 IN PROGRESS** — code, unit tests and docs done; the DB-gated integration suite
  has not been run yet (needs a disposable Postgres).
- **cm18 IN PROGRESS** (started 2026-10-12) — code, unit/component tests done; DB-gated
  suite not yet run (disposable Postgres), ac04 spec change awaiting approval.

| Unit | Name                                                        | Boundary | Status      | Commit |
| ---- | ----------------------------------------------------------- | -------- | ----------- | ------ |
| cm17 | Billing Account template reference column                   | DB       | In progress | c0b2f97 |
| cm18 | Onboarding wizard: "Invoice template" field                 | APP      | In progress | —      |
| cm19 | View Customer: tab shell (Profile · Contacts · Accounts)    | APP      | Not started | —      |
| cm20 | View Customer: Accounts tab                                 | APP      | Not started | —      |
| cm21 | Manage Customer: Billing account panel + template reset     | APP      | Not started | —      |
| cm22 | Binding update ship gate: guardrails, end-to-end flow, docs | TESTS    | Not started | —      |

## Invoice Template Binding update — cm17 IN PROGRESS (started 2026-10-12)

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
  - **OPEN, blocking cm17 sign-off:** run the integration suite on a disposable
    Postgres (fresh-migrate path), and confirm `0050` applies on a database already at
    `0049`. Then commit and record the hash above.

## Invoice Template Binding update — cm18 IN PROGRESS (started 2026-10-12)

- **cm18 — Onboarding wizard "Invoice template" field.** Boundary: APP. Spec:
  `context/customer-management/specs/cm18-onboarding-invoice-template-field.md`.
  Authorized by D2, D11, D13, D15, Inv. #18. Depends on cm17.
  - **Delivered:**
    - `services/accounts/assert-bindable-template.ts` (new): v1 rule only, `null` → ok,
      any string → `TEMPLATE_NOT_BINDABLE`; takes `tx` for the Phase 3 signature, no
      DB call.
    - `validation/accounts/onboard-customer-accounts.schema.ts`: optional nullable
      `billTemplateVersionId` (`/^BTVd{8}$/`).
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

## Outstanding / Next

- **cm17:** committed (`c0b2f97`); finish the DB-gated run above.
- **cm18:** DB-gated run + ac04 spec approval above, then commit.
- **cm19 next** (may proceed alongside; depends only on cm05).

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

- None yet.
