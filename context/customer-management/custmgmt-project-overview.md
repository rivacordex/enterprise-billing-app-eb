# Customer Management Module — Project Overview

## Overview

The Customer Management Module is the section of the Enterprise Billing App (Telco) where the Revenue Operations team maintains enterprise customer records. It manages three linked entities: the legal organization (`organization`), its customer role with lifecycle status and a JSONB specification (`party_role`), and its contact people with inline phone/email/address details (`contact_medium`, one flattened row per contact person). The module provides two pages under a new "Customer" navigation section — View Customer (read-only search and inspect, USER and MANAGER roles) and Manage Customer (create, update, and status-driven soft delete, MANAGER role only). All customer removal is by status change (Customer → CLOSED, Organization → DISSOLVED); no rows are ever physically deleted except contact records. Every mutation is audited and protected by customer-level optimistic locking.

## Goals

1. Give Revenue Operations one place to find any enterprise customer by organization name or trading name and see its full profile: organization, customer role, and contacts.
2. Let MANAGERs create new customers that always start at Organization = REGISTERED and Customer = INITIALIZED, with no way to pick a different initial status.
3. Enforce the signed-off status transition maps server-side so invalid lifecycle jumps (e.g. DISSOLVED → ACTIVE) are impossible, with a mandatory `status_reason` on every transition.
4. Guarantee exactly one preferred contact per customer (the `party_role.contact_medium` pointer) and exactly one preferred contact method per contact (the `preferred_contact_method` enum), enforced in the database, not by operator discipline.
5. Prevent duplicate customers via a nullable-unique constraint on `registration_number` plus a similar-name warning at creation.
6. Record who changed what and when: audit rows for every mutation, `last_modified_by` on key tables, and optimistic-lock rejection of stale saves.
7. Reuse the existing platform unchanged: better-auth RBAC (USER/MANAGER roles), `system_config`, pg_partman audit schema, and the established module conventions from User Management and Product Management.

## Core user flow

The primary flow — a MANAGER onboards a new enterprise customer and activates it:

1. Sign in as a MANAGER. The sidebar shows the "Customer" section with both entries; a USER sees "Manage Customer" greyed out with a lock icon.
2. Open **Manage Customer**. The page starts empty with a search box.
3. Search the intended name first. Results match organization name and trading name (case-insensitive partial), capped at the `system_config` limit (default 5) with a "refine your search" hint. Confirm the customer does not already exist.
4. Click **Add new customer**. Fill in organization fields (name required; type COMPANY or GOVERNMENT; registration number, tax ID, industry, trading name optional). Statuses are displayed locked: REGISTERED / INITIALIZED. If the registration number already exists, creation is blocked; if similar names exist, a warning shows but does not block.
5. Fill the specification JSON (`CUST_TYPE`, `PARTY_TYPE`, `CUST_KEY` — free custom values; the payload must parse as valid JSON).
6. Click **Create customer**. IDs are generated from per-entity sequences (`ORG0000004`, `PTRL00000004`) and the edit screen opens.
7. Add the first contact (name + contact role). It automatically becomes the preferred contact. Add its phone, email, and address; the first method filled automatically becomes the preferred contact method.
8. Progress the lifecycle: set Customer status INITIALIZED → VALIDATED with a status reason, save; then VALIDATED → ACTIVE; set Organization REGISTERED → ACTIVE. Each dropdown offers only the valid next states from the transition map, and save is rejected without a reason.
9. Save. The server compares the loaded `last_modified_datetime`; if another user changed the customer meanwhile, the save is rejected with a reload prompt. On success, audit rows record actor, timestamp, and before/after values.
10. Any USER can now open **View Customer**, search for the customer, and see the three read-only sections: Party – Organization, Role – Customer, Customer – Contact Details (on the Profile and Contacts tabs since cm19).

Billing accounts follow-on (Invoice Template Binding update, cm17–cm22, signed off 2026-10-25; template types since the Invoice Template Types update, cm23–cm24, delivered 2026-10-26):

11. While the customer is INITIALIZED, a user holding `customers : EDIT` and `accounts_transactions : EDIT` onboards it from Manage Customer through the onboarding wizard. The wizard shows a read-only **Invoice template type: Standard (default)** field after Currency, with the help text "New billing accounts use the Standard invoice template. Choose another type afterwards in Manage Customer › Billing account." Submitting moves the customer to VALIDATED and creates the Financial Account and its Billing Account (BAN) on Standard (`NULL`).
12. On **View Customer**, the **Accounts** tab (`?tab=accounts`, needs `accounts_view : READ`) shows the Financial Account summary, each BAN with state, bill cycle, payment term, live receivable and its **Invoice template type** label ("Standard (default) · vN" or "{type name} · vN", the type and version the next bill run will capture, read live), and a paginated read-only document list that links into the Accounts module.
13. On **Manage Customer**, the **Billing account** panel lists each BAN with its type label. Each open BAN has an **Invoice template type** select ("Standard (default)" first, then every usable type by name) and a **Save** button, enabled only when the selection differs from the BAN's current type and the user also holds `accounts_transactions : EDIT`; otherwise the panel is read-only. A save is audited and applies from the next bill run start or rerun. Billing's retire of a type moves its BANs to the chosen target, and these screens show the new type on the next load.

## Features

### Search and viewing

- Search-only landing page (empty start) on both View and Manage; case-insensitive partial match on `organization.name` and `organization.trading_name`.
- Result limit read from `system_config` (`CUSTOMER_SEARCH_RESULT_LIMIT`, default 5) with match-count hint.
- Read-only detail page with three sections: Party – Organization, Role – Customer (including read-only account reference and JSONB specification), Customer – Contact Details. Since the Invoice Template Binding update (cm19) they sit on URL-driven tabs (`?tab=`): **Profile** (Organization + Customer Role, the default), **Contacts** (Contact Details) and **Accounts** (billing accounts, cm20); the inconsistency banner shows above the tabs on every tab.
- Inconsistency warning banner when statuses conflict (e.g. ACTIVE customer on a SUSPENDED organization) — warn only, no cascade.

### Billing accounts and invoice template (Invoice Template Binding update, cm17–cm22, signed off 2026-10-25; Invoice Template Types, cm23–cm24, delivered 2026-10-26)

- **Tabs (cm19):** View Customer detail is a server-rendered tab strip — Profile (default), Contacts, Accounts — driven by `?tab=`; an unknown value falls back to Profile.
- **Accounts tab (cm20):** read-only. Four states: locked (no `accounts_view : READ`; nothing is fetched), not onboarded, onboarded with no documents, and the normal view (Financial Account summary, one card per BAN with state chip, bill cycle, resolved payment term, live receivable and invoice template type label, and a paginated document list per Financial Account). Document ids link to the Accounts Transactions page when the viewer holds `accounts_transactions : READ`. Data loads only on this tab, under Suspense; a failed read stays inside the tab.
- **Onboarding field (cm18; wording cm23):** the onboarding wizard shows a read-only "Invoice template type: Standard (default)" field with help text; the BAN is created on Standard (`NULL`). There is no type choice at onboarding.
- **Billing account panel (cm21; type select cm23):** Manage Customer lists every BAN with its type label, and each open BAN has an **Invoice template type** select and **Save** (enabled only with `accounts_transactions : EDIT` and a changed selection), under the caption "Changes apply from the next bill run start or rerun." A closed BAN shows "Billing account is closed" and no select. A failed accounts read shows an "unavailable" card inside the panel and leaves the rest of the page editable. The bind is audited (`BILLING_ACCOUNT_TEMPLATE_CHANGED`), locks the BAN rather than the customer, and writes nothing when the value is unchanged. A save to a type retired meanwhile shows "This invoice template type is no longer available. It may have been retired. The account's current type has been reloaded." and reloads.
- **A real binding:** a BAN references a template **type** (`NULL` = Standard), and Billing's bill run captures that type and its ACTIVE version at run start or rerun. Details: **Invoice Template Types — Customer Management part** below.

### Customer lifecycle

- Server-enforced transition maps: Organization (REGISTERED → ACTIVE; ACTIVE ↔ INACTIVE/SUSPENDED; any → DISSOLVED/MERGED terminal) and Customer (INITIALIZED → VALIDATED → ACTIVE ↔ SUSPENDED; any → CLOSED terminal). No skipping VALIDATED.
- Mandatory `status_reason` on every transition; UI dropdowns offer only valid next states.
- Soft delete only: "delete" = CLOSED (customer) / DISSOLVED (org). CLOSED is terminal; a returning customer gets a new `party_role` under the same organization, with at most one non-closed customer role per organization (partial unique index).
- New customers always start REGISTERED / INITIALIZED.

### Contacts and preferred logic

- Flattened `contact_medium`: one row per contact person with inline phone, email, and address columns (max one of each per contact).
- Exactly one preferred contact per customer via the `party_role.contact_medium` pointer (nullable, composite deferrable FK to `(id, ref_party_role)`); first contact auto-preferred; deleting the preferred contact is blocked until another is made preferred.
- Exactly one preferred method per contact via `preferred_contact_method` ∈ {PHONE, EMAIL, ADDRESS}; must name a populated method; first method filled is auto-preferred; clearing the preferred method is blocked while another is populated.
- Contact rows may be hard-deleted (audited) — the only physical deletes in the module.

### Data integrity and audit

- Nullable-unique constraint on `registration_number`; similar-name warning (non-blocking) at creation.
- Specification JSONB validated as well-formed JSON; `CUST_TYPE` / `CUST_KEY` / `PARTY_TYPE` are free custom values (accepted risk: no uniqueness or immutability enforcement on `CUST_KEY`).
- Customer-level optimistic locking on `party_role.last_modified_datetime`; `last_modified_by` (FK → appuser) on `organization`, `party_role`, and `contact_medium`.
- All mutations written to the existing pg_partman audit schema with actor, timestamp, entity, and before/after values.

### Access control

- Existing RBAC reused: new `customers` permission rows; USER = View Customer only; MANAGER = View + Manage.
- USER sees Manage Customer greyed out (visible but locked); server actions enforce permissions independently of navigation.

## In scope

- New "Customer" sidebar section with View Customer and Manage Customer pages (5 views: nav, search, read-only detail, edit, add-new).
- Tables: `organization`, `party_role`, `contact_medium` (flattened), with per-entity ID sequences (`ORG…`, `PTRL…`, `CTMD…`), `last_modified_by` columns, and the partial unique indexes / composite FKs listed above.
- Server actions for create, update, status transition, contact add/update/delete, and set-preferred (contact and method), each wrapping validate → mutate → audit in one transaction.
- Transition-map validation, optimistic locking, JSONB well-formedness validation, registration-number uniqueness.
- `system_config` entry for the search result limit.
- RBAC permission rows and seed data for USER/MANAGER access.
- Unit and integration tests (vitest) for transition rules, preferred-contact/method invariants, uniqueness, and locking.

## Out of scope

- Individual (person) customers — `PARTY_TYPE` is always ORGANIZATION this release.
- Accounts, invoicing, payments, and credit checks — `party_role.account` is display-only with no FK; VALIDATED is set manually with no checking logic behind it.
- External or TMF-style APIs (TMF629/632) — the module is UI-only this release.
- Merge tooling — MERGED status can be set, but no record-migration workflow exists.
- Physical deletion of organizations or party roles — soft delete by status only.
- Multiple phones/emails/addresses per contact — one of each (flattened table); a second number requires a second contact row.
- Enum enforcement or uniqueness on `CUST_TYPE` / `CUST_KEY` inside the specification JSONB.
- Reopening CLOSED customers — terminal by design; returning customers get a new party role.

## Success criteria

Done means all of the following are true:

1. A MANAGER can complete the full core user flow above — search, create, add contacts, progress REGISTERED/INITIALIZED to ACTIVE/ACTIVE, and see the result in View Customer — without errors.
2. A USER can search and view any customer but receives no Manage Customer access in either the navigation or direct server-action calls (verified by test).
3. Every invalid status transition (e.g. DISSOLVED → ACTIVE, INITIALIZED → ACTIVE) is rejected server-side with a clear error, and every valid transition without a `status_reason` is rejected — both covered by tests for all map edges.
4. The database itself rejects: a second non-closed customer role for one organization, a duplicate non-null `registration_number`, and a `party_role.contact_medium` pointer to another customer's contact.
5. It is impossible, through any UI or server action, to produce a customer with contacts but no preferred contact, or a contact with populated methods but no preferred method.
6. Two concurrent editors cannot silently overwrite each other: the second save is rejected with a reload prompt (integration test).
7. Every create, update, delete, and status change produces an audit row with actor, timestamp, and before/after values, and `last_modified_by` reflects the true last editor.
8. Search returns correct partial matches on name and trading name, capped by the `system_config` value, defaulting to 5.
9. `npm run typecheck`, `npm run lint`, and the full vitest suite (unit + integration) pass; the module follows the existing `context/` documentation conventions with a progress tracker kept current.

---

## Invoice Template Binding update — delivered scope (cm17–cm22; signed off 2026-10-25)

_Folded from the update overview at sign-off. The flows and features are in **Core user flow** steps 11–13 and **Features › Billing accounts and invoice template** above, which now describe the type binding. This section keeps the rest of the update's record. **Superseded** by the delivered Invoice Template Types update (cm23–cm24, below): the NULL-only rule, the version column (`ref_bill_template_version_id`, dropped by `0054`) and the Reset control no longer exist._

### Goals (as delivered)

1. A nullable `billing.billing_account.ref_bill_template_version_id` (FK to `billing.bill_template_version`), added in one migration with no backfill. `NULL` = follow the current ACTIVE template, else the default.
2. Onboarding confirms the BAN's template inside the existing atomic onboarding transaction.
3. Manage Customer resets a BAN's binding through an audited, concurrency-safe action needing `customers : EDIT` and `accounts_transactions : EDIT`.
4. View Customer shows each BAN's template: "Follows active template (currently: <name> vN), as of now".
5. View Customer becomes three URL-driven tabs (`?tab=profile|contacts|accounts`).
6. An Accounts tab shows the Financial Account summary, each BAN's state, cycle, payment term, live receivable and template, and a paginated document list linking into the Accounts module.
7. The tripwire: any non-`NULL` binding is rejected, so the screen never shows a binding posting ignores.
8. Posting and rendering stay unchanged.

### Data model, access and audit

- **Data model:** one nullable column on `billing.billing_account` (Accounts-owned table). No new tables; no change to `customer_bill`, `bill_run_invoices` or rating tables. Existing BANs read back `NULL`.
- **Access:** no new permission. View page `customers : READ`; Accounts tab content `accounts_view : READ`; onboarding and the reset `customers : EDIT` + `accounts_transactions : EDIT`.
- **Audit:** a new event type `BILLING_ACCOUNT_TEMPLATE_CHANGED` (before/after values). `ACCOUNTS_ONBOARDED` gains the template field.

### In scope (delivered)

- **The column:** its migration, Drizzle mirror and FK.
- **Onboarding:** the schema, service, action and wizard field.
- **The write path:** `assertBindableTemplate` (NULL-only), the `set-billing-account-template` service and action, and the audit event.
- **Manage Customer:** the Billing account panel, greyed by permission.
- **View Customer:** the three-tab shell and the Accounts tab, with its four states, the template label, deep links and the `accounts_view : READ` sub-gate.
- **Tests and docs:** the rewritten page test and the binding test matrix; updated `cm05`, `ac04`, architecture, UI-context and authz-sweep docs.

### Out of scope (as delivered)

- **Choosing a template:** a template catalog or any selectable template; saving a non-`NULL` binding; posting or rendering reading the binding.
- **Other bindings:** CSV or layout template binding; a template-line identifier; version pinning.
- **Transactions:** posting, reversal, payment or other transaction actions in the Accounts tab; reproducing Accounts module screens.
- **Other changes:** additional-BAN creation and BAN filters; new permissions; editing the binding from Accounts screens; backfilling BANs or changing `customer_bill` rows; invoice template editor or company profile changes.

### Success criteria (met at the cm22 ship gate; evidence in `custmgmt-progress-tracker.md` cm22)

1. The column exists, is nullable, has its FK, and every existing BAN reads `NULL`.
2. Onboarding creates the BAN with `NULL`; `ACCOUNTS_ONBOARDED` records the field; the V7 rollback test still leaves nothing behind.
3. A non-`NULL` id to onboarding or the reset returns `TEMPLATE_NOT_BINDABLE` and writes nothing.
4. The reset returns `BAN_NOT_FOUND`, `BAN_CLOSED` and `CONFLICT` in their cases. It writes nothing when the value is already `NULL`, and is rejected without either permission.
5. A `customers : EDIT`-only user sees the panel read-only. With both permissions, the reset applies only to an open, non-`NULL` BAN.
6. Tabs deep-link and fall back to `profile`; the inconsistency banner shows above the strip on every tab.
7. The Accounts tab's locked, not-onboarded and empty states behave; no account query runs without `accounts_view : READ`.
8. The Accounts tab shows the summary, every BAN and the paginated documents; Profile and Contacts run no ledger query.
9. A `NULL` BAN's label reads "Follows active template (currently: <name> vN), as of now".
10. Posting stamps exactly the same versions as before; the bm18, bm19 and bm54 stamp tests pass.
11. The rewritten page test and the matrix tests, including the service-level journey, pass.
12. Typecheck, lint and vitest pass on a disposable Postgres.
13. The `cm05`, `ac04`, architecture and UI-context docs moved with the code.

---

## Invoice Template Types — Customer Management part (delivered, cm23–cm24)

_Folded from the Customer Management update overview at the cm24 ship gate (2026-10-26, joint with Billing bm85); cm23 was built 2026-10-26 in one merge with Billing bm82. The owning update is Billing's (template types, upload, activation, retire, export and the bill run's capture). **Users:** RevOps staff holding `customers : EDIT` + `accounts_transactions : EDIT` bind BANs; everyone holding `customers : READ` (+ `accounts_view : READ`) sees the binding. Rules: `custmgmt-architecture.md` Inv. #19–#22 and §8, `custmgmt-code-standards.md` §10, `custmgmt-ui-context.md` §10, `custmgmt-ai-workflow-rules.md` §10._

### Overview

Before this update a BAN's invoice template reference accepted only `NULL` ("follow the active template"), the Manage Customer panel offered only a never-enabled "Reset to follow active template" button, and posting ignored the reference. Billing's update introduced a catalog of **invoice template types**: Standard plus any number of new types, each with its own layout. This update lets RevOps **bind each BAN to a usable type** from Manage Customer. `NULL` still means Standard. The bill run captures the BAN's type at the next run start or rerun, and View Customer and Manage Customer show the type each BAN will invoice on.

### Goals (as delivered)

1. **The BAN references a type, not a version:** `billing.billing_account.ref_bill_template_family_id` (FK to `billing.bill_template_family`), with `NULL` = Standard. `ref_bill_template_version_id` is dropped; the migration (`0054`) aborts if any BAN holds a non-`NULL` version value.
2. **RevOps binds a BAN to any usable type** (not retired, has an ACTIVE version), or back to Standard, from the Manage Customer Billing account panel. The write is audited and concurrency-safe.
3. **Standard is stored only as `NULL`.** Choosing "Standard (default)" writes `NULL`; an explicit Standard id is rejected.
4. **Binding is serialised against Billing's retire:** the bind gate locks the type row `FOR SHARE` and re-checks that it is usable inside the same transaction.
5. **The screen shows the truth:** every BAN label names the type and the version the next bill run will capture, read live.
6. **Onboarding is unchanged in behaviour:** a new BAN starts on Standard (`NULL`); only the field's wording changed.

### Core user flow

1. **Bind a BAN (RevOps, `customers : EDIT` + `accounts_transactions : EDIT`).**
   1. Open **Manage Customer** for an onboarded customer. The **Billing account** panel lists each BAN with its state chip and current type label.
   2. Each open BAN row shows an **Invoice template type** select: **"Standard (default)"** first, then every usable type in name order. The select starts on the BAN's current type, and **Save** is enabled only when the selection differs from it.
   3. A user with `customers : EDIT` only sees the select and Save disabled, with the `EDIT_DISABLED_TITLE` tooltip. A closed BAN shows "Billing account is closed" and no select.
   4. **Save** runs one transaction:
      1. the BAN's compare-and-set on `last_modified` (`CONFLICT` if stale)
      2. `assertBindableTemplate`, which locks the chosen type `FOR SHARE` and requires it to be usable (`TEMPLATE_NOT_BINDABLE` if not); `NULL` needs no lock
      3. the column update and `last_edited_by`
      4. `BILLING_ACCOUNT_TEMPLATE_CHANGED`, with before and after type id and name

      If the value is unchanged, nothing is written and no audit row is recorded.
   5. If the chosen type was retired while the panel was open, the save fails with **"This invoice template type is no longer available. It may have been retired. The account's current type has been reloaded."** The panel reloads the BAN's current type and the usable-type list. There is no automatic retry.
   6. The caption under the panel reads **"Changes apply from the next bill run start or rerun."** Runs already in progress keep the type they captured.
2. **See the binding (anyone with `customers : READ`).**
   - **View Customer → Accounts tab** (`accounts_view : READ`): each BAN card shows **Invoice template type** with the label.
   - **Manage Customer → Billing account panel:** the same label on each row.
3. **Onboard (unchanged behaviour).** The onboarding wizard's read-only field reads **"Invoice template type: Standard (default)"**, with the help text **"New billing accounts use the Standard invoice template. Choose another type afterwards in Manage Customer › Billing account."** The BAN is created with `NULL`.
4. **Retire (Billing-owned, affects these screens).** When a manager retires a type in Invoice Settings, Billing's bulk switch moves every bound BAN to the chosen target and writes one `BILLING_ACCOUNT_TEMPLATE_CHANGED` per BAN with `reason: 'TEMPLATE_TYPE_RETIRED'`. The customer screens show the new type on the next load. Customer Management code takes no part in the switch.

### Features

- **Data model:** one migration on the Accounts-owned `billing.billing_account` (`0054_billing_account_template_type.sql`): add `ref_bill_template_family_id text` (FK to `billing.bill_template_family`, nullable; `NULL` = Standard), abort if any `ref_bill_template_version_id` is non-`NULL`, then drop that column and its FK. No backfill (every BAN was `NULL`), no index. No change to `customer` schema tables.
- **Bind gate:** `assertBindableTemplate(tx, typeId | null)` is the one validator, shared by onboarding and the bind service. `null` is accepted; a type id goes through `lockTemplateType(tx, typeId, 'share')` and is accepted only if it exists, isn't Standard, isn't retired and has an ACTIVE settings version. Anything else is `TEMPLATE_NOT_BINDABLE`.
- **Bind service and action:** `setBillingAccountTemplate` keeps its delivered shape (BAN compare-and-set, one transaction, no write on an unchanged value) and takes `typeId | null`. Result codes: `BAN_NOT_FOUND`, `BAN_CLOSED`, `CONFLICT`, `TEMPLATE_NOT_BINDABLE`. The action keeps its dual guard (`customers : EDIT`, then `accounts_transactions : EDIT`), then Zod, the service and `revalidatePath` on the manage and view routes.
- **Usable-type list and labels:** `listBindableTemplateTypes()` reads Billing's type **repository** (never a Billing service) and returns "Standard (default)" (`typeId: null`) first, then usable types by name. `resolveBanTemplateLabels` reads live, one read per distinct type, never cached:
  - `NULL` → **"Standard (default) · v{N}"**, where N is Standard's ACTIVE version
  - a usable type → **"{type name} · v{N}"**
  - a retired type or one with no ACTIVE version (possible only after an SQL bypass) → **"{type name} · not usable"**, styled as a warning, because the next run will block that BAN's approval until it is rebound or the type is activated

  The old strings "Follows active template (currently: … vN), as of now" and "Template reference not supported yet" are gone.
- **Manage Customer panel:** the Reset button is replaced by the per-BAN select and Save (Core user flow 1). Permission greying, closed-BAN handling, the in-panel `AccountsUnavailableCard` and one-save-at-a-time behaviour are unchanged.
- **View Customer Accounts tab:** each BAN card's template line reads **"Invoice template type"** with the new label. The tab stays read-only, with no binding control.
- **Onboarding:** only the field's label and help text changed (Core user flow 3). It still submits `null`, reads no type list, and keeps its dual guard and atomic transaction.

### Access and audit

| Action | Permission |
|---|---|
| View the label (Manage Customer, View Customer Accounts tab) | `customers : READ` / `customers : EDIT` page guards, + `accounts_view : READ` for the Accounts tab |
| Bind or rebind a BAN | `customers : EDIT` + `accounts_transactions : EDIT`, re-checked in the action |

No new permission and no new audit event type. `BILLING_ACCOUNT_TEMPLATE_CHANGED` carries the type id and name before and after, plus an optional `reason` (set only by Billing's retire switch).

### In scope (delivered)

- The `billing_account` migration (version reference → type reference), its Drizzle mirror and FK.
- `assertBindableTemplate` accepting usable types under `FOR SHARE`, and rejecting an explicit Standard id.
- `setBillingAccountTemplate` and its action taking `typeId | null`, with unchanged guards, locking and audit.
- `listBindableTemplateTypes` and the new `resolveBanTemplateLabels`.
- The Manage Customer panel select and Save, the retired-type message and the "next bill run" caption.
- The View Customer Accounts tab label.
- Onboarding wording.
- Tests: the bind gate, the panel, labels, the migration abort, and the race with Billing's retire (shared with Billing).
- Docs: the Customer Management architecture, code standards, UI context and workflow rules, plus the `cm05` and `ac04` specs where they quoted the old wording.

### Out of scope

- **Creating, uploading, activating, retiring or exporting template types.** All of these are Billing's (Invoice Settings).
- **Choosing a type during onboarding.** A new BAN always starts on Standard.
- **Binding from Accounts-module screens,** or bulk-binding several BANs at once. Bulk moves happen only through Billing's retire.
- **Pinning a BAN to a specific version.** A BAN follows its type's ACTIVE version.
- **A new permission or a new audit event type.**
- **Any change to the `customer` schema,** the transition maps or the customer lock (`party_role.last_modified_datetime`).
- **Showing a BAN's invoice preview** on customer screens.

### Success criteria (met at the cm24 ship gate)

_Evidence for each criterion is in `custmgmt-progress-tracker.md` cm24._

1. After the migration, `billing.billing_account.ref_bill_template_family_id` exists (nullable, FK to `bill_template_family`), `ref_bill_template_version_id` is gone, and every BAN reads `NULL`. On a database holding a non-`NULL` version binding, the migration aborts and drops nothing.
2. A user with both permissions binds an open BAN to a usable type: one row update, one `BILLING_ACCOUNT_TEMPLATE_CHANGED` with type names before and after, the BAN's `last_modified` bumped, and `party_role.last_modified_datetime` untouched.
3. Choosing "Standard (default)" writes `NULL`. Sending Standard's id, an unknown id, a retired type or a not-yet-usable type returns `TEMPLATE_NOT_BINDABLE` and writes nothing.
4. A stale save returns `CONFLICT`; a closed BAN returns `BAN_CLOSED`; another customer's BAN returns `BAN_NOT_FOUND`; an unchanged value writes nothing.
5. The action rejects a user missing `customers : EDIT` or `accounts_transactions : EDIT`, even with the UI bypassed. The panel greys the select and Save for a `customers : EDIT`-only user.
6. A bind racing Billing's retire of the same type either commits first (and is then switched by the retire) or fails `TEMPLATE_NOT_BINDABLE`. It never leaves a BAN on a retired type.
7. The panel and the Accounts tab show "Standard (default) · vN" for a `NULL` BAN and "{type} · vN" for a bound BAN, from a live read. Neither old label string exists in the code.
8. After a type is retired in Invoice Settings, the panel and the Accounts tab show each moved BAN on its new type, and the retired-mid-edit save shows the agreed message and reloads.
9. Onboarding creates the BAN with `NULL`, shows the new wording, and the V7 rollback test still passes.
10. The next bill run after a bind captures the BAN's type and its ACTIVE version (verified in Billing's end-to-end journey).
11. Typecheck, lint and vitest pass on a disposable Postgres. The Customer Management docs and the `cm05`/`ac04` specs moved with the code.
