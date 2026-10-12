# Customer Management — Update Overview (Customer ↔ Billing Account ↔ Invoice Template Binding)

**Source plan:** `_updatemodule-customer-accounts-invoice-template-binding-plan.md` (eng-reviewed 2026-10-10; decisions D1–D16 are authoritative).
**Users:** Revenue Operations (RevOps).
**Status:** Planned. This is Phase 2 of Invoice Template management. Phase 1 (template editor, versions, company profile, in the billing module) is described in `billmgmt-project-overview.md`. Phase 3 (template catalog selection, posting reads the binding) is not part of this update.
**Owning module:** Customer Management (View Customer and Manage Customer pages). **Also touched:** Accounting (onboarding wizard, `billing.billing_account`, the Accounts-tab read services) and Billing (template read helpers only; posting and rendering are unchanged).

---

## Overview

The Enterprise Billing App is a telco billing system for Revenue Operations. It holds customers, their financial and billing accounts (BANs), and the monthly bill run that rates usage, assembles each BAN's draft bill, posts one `INV` document per BAN to the ledger, renders the invoice PDF from a versioned template, and distributes it over SFTP. Today RevOps cannot see which invoice template a BAN uses, because the choice is implicit: one global template, resolved at posting as the current ACTIVE version, else the default. This update adds a nullable template reference to each billing account, lets RevOps confirm it during customer onboarding and reset it in Manage Customer, shows it on View Customer, and rebuilds View Customer as three tabs (Profile, Contacts, Accounts) so the customer's accounting information sits beside the customer record. It is plumbing only. In this release the reference can only be empty, which means "follow the current ACTIVE template", and posting does not read it.

---

## Goals

1. Add a nullable column `billing.billing_account.ref_bill_template_version_id` with a foreign key to `billing.bill_template_version`, in one migration, with no backfill. `NULL` means "follow the current ACTIVE template, else the default".
2. Let RevOps confirm the invoice template for a BAN inside the existing onboarding wizard, written in the same atomic transaction that creates the Financial Account and BAN.
3. Let RevOps reset a BAN's template binding from Manage Customer, through an audited, concurrency-safe action that requires both `customers:EDIT` and `accounts_transactions:EDIT`.
4. Show each BAN's tied template on View Customer, labelled with the live outcome: "Follows active template (currently: <name> vN), as of now".
5. Rebuild View Customer as three URL-driven tabs (`?tab=profile|contacts|accounts`) without changing the existing section components, the not-found state, or the page guard.
6. Add an Accounts tab that shows the customer's Financial Account summary, each BAN's state, bill cycle, payment term, live receivable balance and tied template, and a paginated list of the Financial Account's `billing.document` rows, each linking into the Accounts module.
7. Enforce the tripwire in code: v1 rejects any non-`NULL` binding, so the Accounts tab can never display a binding that posting ignores.
8. Keep posting and rendering unchanged: `resolveVersionsForPosting` and `resolveTemplate` do not read the new column in this release.

---

## Core user flow

1. **Onboard (RevOps, `customers:EDIT` + `accounts_transactions:EDIT`).**
   1. Open Manage Customer for a customer in status `INITIALIZED`. The Customer Role form opens the onboarding wizard (`components/customers/onboard-accounts-wizard.tsx`).
   2. Fill currency, bill cycle, credit limits and the optional payment-term override, as today.
   3. Confirm the new **Invoice template** field. It has one option, "Follow active template", pre-selected. Help text reads "Invoices use the active template. Per-customer templates are not available yet."
   4. Submit. One transaction sets the customer to `VALIDATED`, inserts the Financial Account, inserts the BAN with `ref_bill_template_version_id = NULL`, creates the three pgledger accounts and bindings, and writes the `ACCOUNTS_ONBOARDED` audit event with the new field in `afterData`. Any failure rolls back everything.
2. **View (RevOps, `customers:READ`).**
   1. Open `/customers/view/<id>`. The Profile tab opens by default and shows the Organization and Customer Role sections. The inconsistency banner, when `isStatusInconsistent` is true, appears above the tab strip on every tab.
   2. Open the Contacts tab to see the contact details section.
   3. Open the Accounts tab (`?tab=accounts`). Without `accounts_view:READ` it shows "Requires accounts access" and loads no data.
   4. With access, the tab shows one of three states: not onboarded (the customer has no Financial Account), onboarded with no documents, or the normal view. Together with the locked state in step 3, these are the four states of the tab. The normal view lists the Financial Account summary (receivable, unapplied cash, deposits held), one card per BAN (id, state, bill cycle, resolved payment term, live balance, tied template), and a paginated document list.
   5. Click a document row to open the matching Accounts page (Ledger Explorer or Transactions) with the selection carried over.
3. **Reset the binding (RevOps, `customers:EDIT` + `accounts_transactions:EDIT`).**
   1. Open Manage Customer for an onboarded customer. The new **Billing account** panel lists each BAN with its tied template.
   2. A user holding only `customers:EDIT` sees the panel read-only, with the "no edit access" tooltip.
   3. A user holding both permissions clicks **Reset to follow active template**. The action locks the BAN row, compares `last_modified`, and rejects a closed BAN. If the stored value is already `NULL` it writes nothing and records no audit event. Otherwise it updates the column, sets `last_edited_by`, and writes `BILLING_ACCOUNT_TEMPLATE_CHANGED` with before and after values, in one transaction.
4. **Post and render (unchanged).** A bill run posts each BAN and stamps the current ACTIVE generated version, CSV version and company profile version on the bill. The BAN's binding plays no part.

---

## Features

### Data model

- One new nullable column, `billing.billing_account.ref_bill_template_version_id` (text), with a real foreign key to `billing.bill_template_version(bill_template_version_id)`, added in one migration (DDL of record in `db/migrations/`, Drizzle mirror in `db/schema/billing/accounts.ts`).
- Meaning of the column: "follow the template line", not a version pin. Non-`NULL` values (Phase 3) will resolve to their line's ACTIVE version, kind `generated` only. The CSV template stays global.
- No new tables. No change to `customer_bill`, `bill_run_invoices` or any rating table.
- Existing BANs read back `NULL`.

### Onboarding

- `validation/accounts/onboard-customer-accounts.schema.ts` gains optional `billTemplateVersionId` (`string | null`, always `null` in v1).
- `services/accounts/onboard-customer-accounts.ts` passes the value through the shared `assertBindableTemplate` and into `billingAccountRepository.insert`.
- The wizard gains the single-option **Invoice template** select, with options read through `billTemplateVersionRepository`.
- The dual-permission guard is unchanged.

### Template binding write path

- New `actions/accounts/set-billing-account-template.ts` and `services/accounts/set-billing-account-template.ts`.
- Shared `assertBindableTemplate(tx, id | null)`: `null` is accepted, any other value is rejected with `TEMPLATE_NOT_BINDABLE` in v1.
- Result codes: `BAN_NOT_FOUND`, `BAN_CLOSED`, `CONFLICT` (stale `last_modified`), `TEMPLATE_NOT_BINDABLE`.
- Locking uses `findStateByIdForUpdate`. The update, `last_edited_by` and the audit event commit in one `db.transaction`.
- The action re-checks `customers:EDIT` and `accounts_transactions:EDIT` on the server, then calls `revalidatePath` on the manage and view routes.

### Manage Customer panel

- New "Billing account" panel on `app/(app)/customers/manage/[id]/page.tsx`. The page guard stays `customers:EDIT`.
- Enabled only when the `permissionMap` returned by `requirePermission` includes `accounts_transactions:EDIT`; otherwise read-only, using the `EDIT_DISABLED_TITLE` pattern from `components/accounts/edit-access.ts`.

### View Customer tabs

- `app/(app)/customers/view/[id]/page.tsx` stays a server component. Tab selection comes from the `tab` search parameter; an unknown value falls back to `profile`.
- Profile = `OrganizationSection` + `CustomerRoleSection`. Contacts = `ContactDetailsSection`. Accounts = new.
- The three existing section components, the not-found card and `metadata.title` do not change.

### Accounts tab

- One read service, `getCustomerAccountsSummary(partyRoleId)`, composes the Financial Account (`financialAccountRepository.findByPartyRoleIds`), its BANs (`billingAccountRepository.findByFinancialAccountId`), FA balances via `getFinancialAccountDetail`, per-BAN receivables in one grouped `pgledger_accounts_view` read, and the tied-template label.
- Document list: `listTransactionDocuments(financialAccountId, null, params, pageSize)`. Page size is a `system_config` key following the existing search-limit convention.
- Account data loads in an async child component rendered only when `tab=accounts`, inside a Suspense boundary, so other tabs run no ledger or document queries.
- Read-only: no posting, reversal or transaction actions. The tab imports no write or posting module.
- Handles one to N BANs, and shows a state chip for closed BANs.

### Access and audit

- No new permissions. View page: `customers:READ`. Accounts tab content: `accounts_view:READ`. Onboarding and template reset: `customers:EDIT` + `accounts_transactions:EDIT`.
- New audit event type `BILLING_ACCOUNT_TEMPLATE_CHANGED`, added to the audit category map. `ACCOUNTS_ONBOARDED` gains the new field.

### Tests

- Tests follow the matrix in section 11 of the source plan: migration/column integration, onboarding extension (with `v07-onboarding-atomicity`), `assertBindableTemplate`, the set-template service and action, the summary service, the label resolver, the rewritten View Customer page test, the Billing account panel component test, and one DB-gated service-level journey test (browser e2e is deferred to `_newmodule-playwright-e2e-testing-plan.md`).

---

## In scope

- Migration, Drizzle mirror and foreign key for `billing_account.ref_bill_template_version_id`.
- Onboarding schema, service, action and wizard field.
- `assertBindableTemplate` (NULL-only in v1), `set-billing-account-template` service and action, `BILLING_ACCOUNT_TEMPLATE_CHANGED` audit event.
- Manage Customer "Billing account" panel with permission-based greying.
- View Customer three-tab shell, URL-driven, with the banner above the tab strip.
- Accounts tab: four states, `getCustomerAccountsSummary`, template label, paginated document list, deep links into Accounts pages, `accounts_view:READ` sub-gate, fetch only on `tab=accounts`.
- The template-label read helper, using `billTemplateVersionRepository.findActive` and `findDefault`.
- Rewriting the View Customer page test that asserts "all three section titles", plus the tests listed above.
- Documentation updates after build: the `cm05` View Customer spec, the onboarding spec `ac04`, the customer and accounting architecture and UI context docs, and the authz sweep specs.

---

## Out of scope

- A template catalog or any selectable non-default template. The Manage Customer panel offers reset only.
- Saving any non-`NULL` binding. `assertBindableTemplate` rejects it; this is lifted only in Phase 3.
- Posting or rendering reading the binding. `resolveVersionsForPosting`, `resolveTemplate` and `post-run.ts` are unchanged.
- Binding the CSV or layout template kinds. The column is defined for kind `generated` only.
- A template-line identifier. `bill_format` stays locked to `INVOICE`; the identifier is a Phase 3 deliverable.
- Pinning a BAN to a specific version id.
- Posting, reversal, payment or other transaction actions inside the Accounts tab.
- Reproducing Accounts Overview, Ledger Explorer or Transaction detail inside the customer screen.
- Additional-BAN creation UI and BAN selection filters.
- New permissions.
- Editing the binding from Accounts-module screens.
- Backfilling existing BANs or changing existing `customer_bill` rows.
- Changes to the invoice template editor, company profile, or the layout v2 work tracked in known-issues §20.

---

## Success criteria

1. After migration, `billing.billing_account.ref_bill_template_version_id` exists, is nullable, has a foreign key to `billing.bill_template_version`, and every existing BAN reads back `NULL`.
2. Onboarding a customer creates the BAN with `ref_bill_template_version_id = NULL`; the `ACCOUNTS_ONBOARDED` audit event includes the field; the V7 rollback test still leaves no party-role status change, Financial Account, BAN, ledger account or binding after a forced failure.
3. Passing any non-`NULL` template id to onboarding or to the reset action returns `TEMPLATE_NOT_BINDABLE` and writes nothing.
4. The reset action returns `BAN_NOT_FOUND`, `BAN_CLOSED` and `CONFLICT` in the matching cases, writes no row and no audit event when the value is already `NULL`, and is rejected without `customers:EDIT` and without `accounts_transactions:EDIT`.
5. On Manage Customer, a user with `customers:EDIT` only sees the Billing account panel read-only with the tooltip; a user with both permissions can use it.
6. `/customers/view/<id>` renders three tabs with `profile` as the default; `?tab=contacts` and `?tab=accounts` deep-link; an invalid `tab` value falls back to `profile`; the inconsistency banner appears above the tab strip on every tab, under the same `isStatusInconsistent` rule as before.
7. Without `accounts_view:READ` the Accounts tab shows "Requires accounts access" and no account query runs. For an `INITIALIZED` customer it shows the not-onboarded state. For an onboarded customer with no documents it shows the empty state.
8. The Accounts tab shows the Financial Account summary, every BAN with state, cycle, resolved term, live balance and tied-template label, and a paginated document list; each row links to the matching Accounts page. On the Profile and Contacts tabs, no ledger, balance or document query runs.
9. For a BAN with `NULL`, the label reads "Follows active template (currently: <name> vN), as of now", where the name and version come from the same `findActive ?? findDefault` rule the resolver uses.
10. A bill run posted after this release stamps exactly the same template, CSV and profile versions as before it, whatever the BAN column holds; the existing bm18, bm19 and bm54 stamp tests pass unchanged.
11. The rewritten `tests/app/customers-view-detail-page.test.tsx` passes; the new tests listed in the source plan's matrix pass, including the service-level journey test (onboard → accounts summary → template label → reset path).
12. `npm run typecheck`, `npm run lint` and the vitest suite pass on a throwaway Postgres marked disposable. The known failures in `billmgmt-known-issues.md` §21 are fixed or confirmed unrelated before this update is signed off.
13. The `cm05`, `ac04`, architecture and UI-context docs for the touched modules are updated in the same change set as the code.
