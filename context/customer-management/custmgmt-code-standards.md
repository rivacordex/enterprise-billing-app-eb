# Customer Management — Module Code Standards

> **PLANNED** — module-specific delta to `../code-standards.md` (the overarching standards). This file contains **only** Customer Management specifics; everything else (TypeScript, Next.js, styling, API, data, file organization, CI gates) is inherited unchanged and is not restated here. If a rule seems missing, it lives in the general file.

**Companion docs:** `custmgmt-project-overview.md` (product spec), `custmgmt-update-overview.md` (the in-flight **Invoice Template Types** update, Customer Management part; rules in §10 below) and `custmgmt-architecture.md` (technical design, numbered **Module Invariants**, #19–#22 planned). Where this doc conflicts with the architecture _Invariants_, the **Invariants win** and the conflict is a bug to fix here.

---

## 1. General Rules (module-specific)

1. **v1 is full CRUD, not read-only.** Unlike Product Management's v1, `actions/customer/**` ships from day one: create, update, status-transition, contact add/update/delete, and set-preferred (contact and method) are all live in this release.
2. **Soft delete is the default; `contact_medium` is the one exception.** `organization` and `party_role` rows are never physically deleted — "delete" is Customer → `CLOSED` and Organization → `DISSOLVED` via the transition maps (module inv. #1). `contact_medium` rows are the **only** rows in the module that are ever physically deleted, and only when the row is not the pointed-at preferred contact (module inv. #4).
3. **Status transitions are server-enforced against the signed-off maps.** Every transition call requires a non-null `status_reason`; a transition absent from the map is rejected even if submitted directly to the Server Action, not just filtered out of the UI (module inv. #2).
4. **The UI status control is generated from the transition map, never hand-authored.** The set of next-states offered in a dropdown is computed server-side from the same map the action validates against — one source, not two lists kept in sync by hand.
5. **Every mutation inside a customer is optimistic-lock checked**, per the general optimistic-locking convention (general §6.19): org fields, role/status, contacts, and set-preferred all compare-and-bump `party_role.last_modified_datetime` — this module's lock scope — in the same transaction as the mutation; a stale-copy save is rejected with a typed `CONFLICT` result (general §2.16), never silently overwritten (module inv. #6).
6. **At most one non-closed customer role per organization is a DB constraint, not app logic.** Service code must not rely on a pre-check alone — the partial unique index is the enforcement (module inv. #3, general §6.7 applies with a module-specific partial-index shape).
7. **Preferred-contact and preferred-method invariants are enforced structurally.** `party_role.contact_medium` is NULL iff the customer has zero contacts; `contact_medium.preferred_contact_method` is NULL iff no method is populated. Both are maintained by the mutating service (auto-preferred-on-first-add, blocked-clear-while-populated) — never left to operator discipline (module inv. #4, #5).
8. **`party_role_specification` JSONB is a documented exemption under general §6.17's shape-guarding exception clause** (module inv. #7). Validate **well-formed JSON only** — no Zod shape schema, no discriminated union, no key/enum enforcement. `CUST_TYPE`, `CUST_KEY`, `PARTY_TYPE` are free custom values; `CUST_KEY` uniqueness/immutability is operator discipline by design decision, not a code path to build. This paragraph **is** the required exemption statement — any change narrowing or removing it needs a design review.
9. **`registration_number` is nullable-unique, enforced at the DB.** GOVERNMENT orgs may have no registration number and never collide with each other; COMPANY orgs collide only on a real duplicate (module inv. #8).
10. **`party_role.account` stays display-only.** No FK, no create/edit UI, no linkage logic — an Account module doesn't exist yet. Do not add account fields to any customer form ahead of that module existing (module inv. #9).
11. **The "Manage Customer" nav item renders for every authenticated user** (platform convention) but shows greyed/locked for a USER; the page guard, not the nav state, is the actual enforcement (general §3.6, architecture §4).

---

## 2. TypeScript Conventions (module-specific)

1. **Domain unions** (general §2.6), defined once as `as const` string-literal unions in the module's types:
   - `OrganizationStatus`: `'REGISTERED' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'DISSOLVED' | 'MERGED'`
   - `CustomerStatus`: `'INITIALIZED' | 'VALIDATED' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED'`
   - `OrganizationType`: `'COMPANY' | 'GOVERNMENT'`
   - `PreferredContactMethod`: `'PHONE' | 'EMAIL' | 'ADDRESS'`
2. **Transition maps are typed, single-source `Record`s** in `validation/customer/transitions.ts`:
   ```ts
   export const ORGANIZATION_TRANSITIONS: Record<
     OrganizationStatus,
     readonly OrganizationStatus[]
   > = {
     REGISTERED: ["ACTIVE", "DISSOLVED"],
     ACTIVE: ["INACTIVE", "SUSPENDED", "DISSOLVED", "MERGED"],
     INACTIVE: ["ACTIVE", "SUSPENDED", "DISSOLVED", "MERGED"],
     SUSPENDED: ["ACTIVE", "INACTIVE", "DISSOLVED", "MERGED"],
     DISSOLVED: [],
     MERGED: [],
   } as const;
   ```
   Both the Server Action's validation and the dropdown's available-options query read this same object — never a duplicated literal list (§1.4).
3. **`party_role_specification` is typed `Record<string, unknown>`, not a Zod object schema.** The validator (`validation/customer/specification.schema.ts`) only checks `JSON.parse` succeeds; do not add a `PartyRoleSpecification` interface with named keys — the shape is intentionally unenforced (§1.8).
4. **Entity IDs are plain `string`s validated by Zod format schemas** — `ORG`/`PTRL`/`CTMD` + zero-padded sequence (e.g. `/^ORG\d{7}$/`, `/^PTRL\d{8}$/`, `/^CTMD\d{8}$/` — match the sequence width seeded in the migration). Route params (`[id]`) are parsed against the matching ID schema before any repository call.
5. **Read models live in `types/` as composed shapes** (general §2.7): `OrganizationDetail`, `CustomerRoleDetail` (role + resolved `lastModifiedByName` from `core.APPUSER`), `ContactRow` (flattened phone/email/address + preferred-method flag), `CustomerSearchResult` (org + role status summary for the results table). Services return these, never raw Drizzle rows.
6. **Optimistic-lock payloads carry the loaded `last_modified_datetime`** as a required field on every mutation input type (`UpdateOrganizationInput`, `TransitionCustomerStatusInput`, etc.) — a mutation type without it is a review-blocking defect (§1.5).
7. **Status-transition inputs always require `statusReason: string`** (non-empty, trimmed) — model it as a required field on the Zod schema, not optional-with-a-runtime-check.

---

## 3. Next.js Rules (module-specific)

1. **Two page groups, each search-first with an empty start state:** `app/(app)/customers/view/` (`customers : READ`) and `app/(app)/customers/manage/` (`customers : EDIT`). Neither page pre-loads a result list — both render an empty search box until a query is submitted.
2. **Search state lives in URL searchParams** (`q`) on both search pages, consistent with the platform's URL-as-state convention (general §3, product module precedent). No client-side state store for search text or results.
3. **Status dropdowns are populated server-side from the transition map for the record's current status** (§2.2) — a client component never hard-codes the option list; it receives the computed next-states as props.
4. **The edit page fetches, then round-trips `last_modified_datetime`.** `CustomerEditPage` reads the current value on load and includes it as a hidden field / part of the submitted payload; the Server Action's optimistic-lock check is what actually rejects a stale save (§1.5) — the client value is a courtesy, not the security boundary.
5. **A rejected optimistic-lock save renders a reload prompt, not a silent merge or overwrite.** The Server Action returns the typed `CONFLICT` result per general §2.16 (built on the §2.9 `Result` pattern); the page shows an explicit "this record changed — reload to see the latest" state.
6. **Contact mutations (add/update/delete/set-preferred) are separate Server Actions from the org/role update**, each independently permission- and lock-checked — do not fold contact CRUD into the same action as the organization/role save.
7. **`'use client'` only at interaction leaves** — search input, status-transition select, contact form fields — consistent with general §3.2; the three read-only detail sections (Organization, Customer Role, Contact Details) stay server components on the View page.
8. **Nav renders regardless of permission; the guard enforces** (general convention, §1.11). "Manage Customer" appears greyed/locked for USER; clicking through hits the page guard, not a client-side disable-only check.
9. **Page `metadata.title`** is `"View Customer"` / `"Manage Customer"` per route; every route segment ships `loading.tsx` and `error.tsx` (general §3.11).

---

## 4. Styling (module-specific)

1. **Shared indicator components** (general §4.8), created exactly with these names:
   - `OrganizationStatusBadge` — `REGISTERED | ACTIVE | INACTIVE | SUSPENDED | DISSOLVED | MERGED`
   - `CustomerStatusBadge` — `INITIALIZED | VALIDATED | ACTIVE | SUSPENDED | CLOSED`
   - `OrganizationTypeBadge` — `COMPANY | GOVERNMENT`
   - `PreferredIndicator` — one shared marker for "preferred contact" / "preferred method"; used identically in the contact list and the contact-method rows, never a different icon per context
2. **`StatusTransitionControl` is the one component that renders a status dropdown.** It takes the current status + entity kind (`organization` | `customer`) and derives its options from the transition map (§2.2, §3.3); no page builds its own `<select>` of statuses.
3. **`InconsistencyBanner` is the one component for the cross-status warning** (e.g. ACTIVE customer on a SUSPENDED organization) — warn-only styling (e.g. `border-amber-500`-equivalent semantic token), never a blocking/destructive treatment, since the platform doesn't cascade the mismatch.
4. **`SpecificationEditor` is the one component for editing `party_role_specification`** — a raw JSON textarea/editor with client-side JSON.parse feedback mirroring the server's well-formedness-only check (§1.8, §2.3); do not build a structured key/value form for it.
5. **Three-section detail layout is a responsive stack:** Party – Organization, Role – Customer, Customer – Contact Details, in that order top-to-bottom on narrow viewports, optionally side-by-side on `lg:` and up (general §4.10) — order is fixed, do not reorder per page. Since cm19 the View Customer detail page splits them across URL-driven tabs (`?tab=profile|contacts|accounts`, default and fallback `profile`): **Profile** = Organization + Customer Role (in that order), **Contacts** = Contact Details, **Accounts** = billing accounts (cm20). `CustomerDetailTabs` is the one tab strip — a server component of plain `<Link>`s styled like `components/billing/run-detail-tabs.tsx` (ui-context §9.1); the `InconsistencyBanner` sits above it on every tab.
   The Accounts tab (cm20) is read-only and built from `AccountsLockedCard`, `AccountsNotOnboardedCard`, `FinancialAccountSummaryCard`, `BillingAccountCard` (with `BanStateChip` and the template label), `CustomerDocumentsTable` and `AccountsTabSkeleton`, composed by the presentational `CustomerAccountsTab`; a failed summary read renders `AccountsUnavailableCard` inside the tab. Money uses the Accounts module's `AmountCell` and document state its `DocStateBadge`; the Accounts `documents-table.tsx` is never reused (it imports the reversal mutation path). The summary is fetched by an async loader in the page itself, not in `components/**` (components may not import `services/**`).
   On Manage Customer, `BillingAccountPanel` (cm21, client) lists each BAN with `BanStateChip` and the shared `TemplateLabel` (exported from `billing-account-card.tsx`) and a secondary **Reset to follow active template** button. The button is enabled only with `canEditAccounts` on an open, non-`NULL` BAN, and only one reset runs at a time. Otherwise it shows a caption ("Already following the active template" / "Billing account is closed") and/or the `EDIT_DISABLED_TITLE` tooltip, so in v1 it is always disabled. The panel reuses `AccountsNotOnboardedCard` for the not-onboarded copy and `AccountsUnavailableCard` when `listCustomerBillingAccounts` fails (`accounts: null`; the page's `loadBillingAccounts` catches the error, so the rest of Manage Customer stays usable). The onboarding wizard's **Invoice template** field (cm18) is a read-only "Follow active template" field after Currency, with help text; there is no template picker in v1.

   > **Amended 2026-10-25 (Invoice Template Types; planned, §10).** The **Reset to follow active template** button is replaced by a per-BAN **`TemplateTypeSelect` + Save** (§10, Styling rules 1–3). `TemplateLabel` renders the new type label. The "Already following the active template" caption is removed; the "Billing account is closed" caption stays.
6. **The results table on both search pages reuses the platform table primitives** (general §4.2, product-module precedent) — one `CustomerResultsTable` component shared by View and Manage, not forked per page.

---

## 5. API Routes (module-specific)

1. **This module adds no Route Handlers.** `app/api/**` gains nothing from Customer Management — all reads and writes flow RSC page → `services/customer` → repositories, or Server Action → `services/customer` → repositories (general §5.1 scope: auth provider, callbacks, M2M only).
2. **A PR adding any `app/api/customer*` path is rejected at review.**

---

## 6. Data and Storage Rules (module-specific)

1. **All module tables live in the `customer` schema:** `organization`, `party_role`, `contact_medium` — nothing else, no identity/RBAC/session/config/audit tables (module inv. #10). Cross-schema references go by FK to `core` (`last_modified_by` → `core.APPUSER`).
2. **ID prefixes** (format per general §6.18): `ORG` (organization), `PTRL` (party role), `CTMD` (contact medium) — one sequence per table, e.g. `ORG0000001`, `PTRL00000001`, `CTMD00000001`.
3. **`party_role` carries a partial unique index enforcing at most one non-closed role per organization:** `UNIQUE (engaged_party) WHERE status != 'CLOSED'` (module inv. #3). A returning closed customer gets a **new** `party_role` row under the same organization — `CLOSED` is terminal and is never reopened by an update.
4. **`registration_number` is a nullable-unique column on `organization`** (module inv. #8) — the constraint, not app validation, is the enforcement; a similar-name warning at creation is a non-blocking service-layer check, distinct from this constraint.
5. **`party_role.contact_medium` is a nullable, composite deferrable FK to `(id, ref_party_role)`** on `contact_medium` — this is what makes "a contact pointer to another customer's contact" a DB-level impossibility (module inv. #4), not just a service-layer check.
6. **`contact_medium` is flattened: inline `phone_*`, `email_*`, `ga_*` (address) columns plus `preferred_contact_method`.** Max one phone/email/address per row by column design — a second number is a second row, never an array or child table.
7. **`contact_medium` rows are the module's only physical deletes**, and a delete is blocked at the service layer while the row is the pointed-at preferred contact (module inv. #1, #4) — the delete repository function must not be callable without that check having passed.
8. **`party_role_specification` is validated for well-formed JSON only, on every write including seeds** (§1.8, module inv. #7) — the documented exemption under general §6.17; do not "fix" it by adding shape validation without a design review.
9. **`party_role.last_modified_datetime` is the optimistic-lock column** for the whole customer (org + role + contacts) — any mutation in the customer's scope reads-compares-bumps this one field in its transaction, even a contact-only edit (module inv. #6).
10. **`CUSTOMER_SEARCH_RESULT_LIMIT` lives in `core.SYSTEM_CONFIG`**, `config_group = 'customer'`, default `5` — the search service reads it per request; never hard-code the limit in a component or service. `CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE` (same group, default `20`, capped at `100`, cm20) sizes the Accounts tab document list; both are seeded by `db/seeds/customer.ts` and fall back to their defaults when missing or invalid.
11. **Status changes persist `status_reason` on the row itself, in addition to the atomic `AUDIT_LOG` entry** (module inv. #2, general §1.7) — the reason is queryable directly off `organization`/`party_role`, not only recoverable by reading audit history.
12. **`last_modified_by` (FK → `core.APPUSER`) is required on `organization`, `party_role`, and `contact_medium`** — every repository write sets it from the resolved principal, never left null on an update.

---

## 7. File Organization (module-specific)

Placement per general §7; the module's concrete tree:

```
app/(app)/customers/view/
  page.tsx                    # ViewCustomerSearchPage — guard READ, search, results
  [id]/page.tsx                # CustomerDetailPage — ?tab= profile / contacts / accounts
  loading.tsx
  error.tsx
app/(app)/customers/manage/
  page.tsx                    # ManageCustomerSearchPage — guard EDIT, search, results
  [id]/page.tsx                # CustomerEditPage — org form, role/status, contacts, billing accounts (cm21)
  new/page.tsx                 # NewCustomerPage — create flow
  loading.tsx
  error.tsx
components/customers/
  customer-search-panel.tsx        # CustomerSearchPanel
  customer-results-table.tsx       # CustomerResultsTable
  organization-section.tsx         # OrganizationSection (read-only)
  customer-role-section.tsx        # CustomerRoleSection (read-only)
  contact-details-section.tsx      # ContactDetailsSection (read-only)
  customer-detail-tabs.tsx         # CustomerDetailTabs (View detail tab strip, cm19)
  customer-accounts-tab.tsx        # CustomerAccountsTab (Accounts tab body, cm20)
  accounts-locked-card.tsx         # AccountsLockedCard (no accounts_view : READ)
  accounts-not-onboarded-card.tsx  # AccountsNotOnboardedCard
  accounts-tab-skeleton.tsx        # AccountsTabSkeleton (Suspense fallback)
  accounts-unavailable-card.tsx    # AccountsUnavailableCard (summary read failed; stays in the tab)
  financial-account-summary-card.tsx # FinancialAccountSummaryCard
  billing-account-card.tsx         # BillingAccountCard (+ template label)
  ban-state-chip.tsx               # BanStateChip
  customer-documents-table.tsx     # CustomerDocumentsTable (read-only, deep-links)
  organization-form.tsx            # OrganizationForm
  customer-role-form.tsx           # CustomerRoleForm
  onboard-accounts-wizard.tsx      # OnboardAccountsWizard (ac04; read-only "Invoice template" field, cm18)
  contact-manager-panel.tsx        # ContactManagerPanel
  billing-account-panel.tsx        # BillingAccountPanel (Manage: BANs + template reset, cm21)
  new-customer-form.tsx            # NewCustomerForm
  organization-status-badge.tsx    # OrganizationStatusBadge
  customer-status-badge.tsx        # CustomerStatusBadge
  organization-type-badge.tsx      # OrganizationTypeBadge
  preferred-indicator.tsx          # PreferredIndicator
  status-transition-control.tsx    # StatusTransitionControl
  inconsistency-banner.tsx         # InconsistencyBanner
  specification-editor.tsx         # SpecificationEditor
actions/customer/
  create-customer.ts          # create org + role
  update-organization.ts
  transition-organization-status.ts
  transition-customer-status.ts
  update-party-role-specification.ts
  add-contact.ts
  update-contact.ts
  delete-contact.ts
  set-preferred-contact.ts
  set-preferred-contact-method.ts
services/customer/
  search-customers.ts
  get-customer-detail.ts
  create-customer.ts
  update-organization.ts
  transition-organization-status.ts
  transition-customer-status.ts
  update-party-role-specification.ts
  contact-mutations.ts         # add/update/delete + preferred-pointer maintenance
db/schema/customer.ts          # 3 tables, sequences, enums, constraints, partial unique index
db/repositories/
  organization.ts
  party-role.ts
  contact-medium.ts
db/migrations/…                # schema + `customers` PERMISSIONS row + SYSTEM_CONFIG seed
validation/customer/
  organization.schema.ts
  party-role.schema.ts
  contact-medium.schema.ts
  transitions.ts                # ORGANIZATION_TRANSITIONS / CUSTOMER_TRANSITIONS maps
  specification.schema.ts       # JSON well-formedness only
  update-party-role-specification.schema.ts
  search-params.schema.ts       # search ?q=; CUSTOMER_DETAIL_TABS + detail ?tab= (cm19), ?page= / ?fa= (cm20)
services/accounts/              # Accounts-side services owned here (onboarding field cm18, Accounts tab cm20, BAN panel cm21)
  assert-bindable-template.ts       # assertBindableTemplate — the one validator (cm18); NULL-only until §10 makes it type-aware
  get-customer-accounts-summary.ts  # getCustomerAccountsSummary(partyRoleId, page, pageFinancialAccountId)
  resolve-ban-template-label.ts     # "Follows active template (currently: … vN), as of now"
  list-customer-billing-accounts.ts # listCustomerBillingAccounts(partyRoleId) — Manage panel read (cm21)
  set-billing-account-template.ts   # setBillingAccountTemplate — CAS reset on the BAN lock (cm21)
actions/accounts/
  set-billing-account-template.ts   # dual permission: customers + accounts_transactions : EDIT (cm21)
validation/accounts/
  set-billing-account-template.schema.ts # partyRoleId, billingAccountId, BTV id | null, lastModified (cm21)
tests/…                         # mirrors source; incl. authz-matrix entries for both routes
  guardrails/customer-accounts-read-boundary.test.ts      # Inv. #11 import boundary (cm20)
  guardrails/customer-accounts-binding-boundaries.test.ts # binding-update ship gate (cm22)
  e2e/customer-accounts-journey.integration.test.ts       # DB-gated service-level journey (cm22)
```

1. **`services/customer` stays framework-agnostic** — no `next/*` imports (general §3.14).
2. **Transition maps live only in `validation/customer/transitions.ts`.** No page, component, or action re-declares a status's valid next-states.
3. **Contact mutation logic (preferred-pointer maintenance) lives in `services/customer/contact-mutations.ts`**, not scattered across individual action files — `actions/customer/*-contact*.ts` files stay thin orchestrators calling into it.

---

## 8. Permission Names & Per-Page Permission Map

**v1 permission name** (general §8.1): `customers` — single, page-level, code-seeded via migration. **READ** = View Customer (search + read-only detail). **EDIT** = Manage Customer (create, update, all status transitions, contact CRUD, set-preferred). **No `DELETE` level is seeded for this module** — "delete" is a status transition gated at `customers : EDIT`, and contact hard-delete is also EDIT-gated, not a separate delete permission (architecture §4).

Authoritative for v1; mirrors architecture §4. New pages are appended before they ship — a page with no row here is a bug, not "public" (general §1.11).

| Page                                                                             | Route                    | Top-level component                                                                          | Folder                             | Permission : level     |
| -------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------- |
| View Customer — search                                                           | `/customers/view`        | `ViewCustomerSearchPage` → `CustomerSearchPanel`, `CustomerResultsTable`                     | `app/(app)/customers/view/`        | `customers` : **READ** |
| View Customer — detail                                                           | `/customers/view/[id]`   | `CustomerDetailPage` → `CustomerDetailTabs`; `OrganizationSection`, `CustomerRoleSection`, `ContactDetailsSection`, `CustomerAccountsTab` | `app/(app)/customers/view/[id]/`   | `customers` : **READ** (Accounts tab content: + `accounts_view` : **READ**) |
| Manage Customer — search                                                         | `/customers/manage`      | `ManageCustomerSearchPage` → `CustomerSearchPanel`, `CustomerResultsTable`                   | `app/(app)/customers/manage/`      | `customers` : **EDIT** |
| Manage Customer — edit (org fields, status transitions, contacts, set-preferred) | `/customers/manage/[id]` | `CustomerEditPage` → `OrganizationForm`, `CustomerRoleForm`, `ContactManagerPanel`, `BillingAccountPanel` | `app/(app)/customers/manage/[id]/` | `customers` : **EDIT** |
| Manage Customer — add new                                                        | `/customers/manage/new`  | `NewCustomerPage` → `NewCustomerForm`                                                        | `app/(app)/customers/manage/new/`  | `customers` : **EDIT** |

**Notes**

- Component names are the binding convention; create them exactly so the page ↔ route ↔ component ↔ permission chain stays traceable (general §9).
- A USER holds `customers:READ` only — Manage Customer renders greyed/locked in the nav; the page guard and every `actions/customer/*` Server Action independently reject a USER (defense in depth, architecture §4) even if the nav check is bypassed.
- Deep links (`/customers/view/[id]`, `/customers/manage/[id]`) pass through the same guard as the search pages — the route param grants nothing.
- **Accounts tab sub-gate (cm20, Inv. #12):** on `/customers/view/[id]?tab=accounts` the page additionally checks `accounts_view : READ` once, from the `permissionMap` `requirePermission` returns. Without it the tab renders `AccountsLockedCard` and `getCustomerAccountsSummary` is never called; the page-level permission stays `customers : READ`. Document rows link into `/accounts/transactions` only when the same map also holds `accounts_transactions : READ` (that page's guard); otherwise the ids render as plain text.
- **Onboarding "Invoice template" field (cm18):** no new gate; it rides the existing onboarding action's `customers : EDIT` + `accounts_transactions : EDIT` check.
- **Billing account template reset (cm21, Inv. #16/#17):** `actions/accounts/set-billing-account-template.ts` requires `customers : EDIT` (via `requirePermission`) **and** `accounts_transactions : EDIT` (via `meetsLevel` on the returned `permissionMap`), else `FORBIDDEN`. `/customers/manage/[id]` derives `canEditAccounts` from the same map to grey the panel's reset button (UX only); the page guard stays `customers : EDIT`. The reset locks the BAN's own `last_modified`, never `party_role.last_modified_datetime`.

---

## 9. Module Guardrail Tests (CI gate §10.4)

The general test-suite gate includes this module's guardrail tests from _Success Criteria_, all of which must exist before ship:

1. **Authz matrix** — every route in §8 × every role/level combination, including USER on `/customers/manage/**` → no-access, and direct Server Action calls (bypassing the nav) also rejected for USER.
2. **Full core flow** — search → create → add contact (auto-preferred) → add phone/email/address (auto-preferred method) → INITIALIZED → VALIDATED → ACTIVE, REGISTERED → ACTIVE → visible in View Customer, end to end without errors.
3. **Transition-map edges** — every invalid transition (e.g. `DISSOLVED → ACTIVE`, `INITIALIZED → ACTIVE`) is rejected server-side; every valid transition submitted without `status_reason` is rejected — both for every edge in both maps.
4. **DB constraint tests** — a second non-closed `party_role` for one organization fails at the DB; a duplicate non-null `registration_number` fails at the DB; a `party_role.contact_medium` pointer to another customer's contact fails at the DB.
5. **Preferred invariants** — no UI or Server Action path can produce a customer with contacts but no preferred contact, or a contact with a populated method but no preferred method; deleting the preferred contact is blocked until reassigned; clearing the preferred method is blocked while another method is populated.
6. **Optimistic lock conflict** — two concurrent editors on the same customer: the second save is rejected with the `CONFLICT` result and the reload-prompt UI state, not a silent overwrite.
7. **Audit trail** — every create, update, status change, contact CRUD, and set-preferred call produces an `AUDIT_LOG` row with actor, timestamp, entity, and before/after values; `last_modified_by` reflects the true last editor.
8. **Search correctness** — partial, case-insensitive matches on `organization.name` and `trading_name`; result count capped by `CUSTOMER_SEARCH_RESULT_LIMIT` (default 5) with the refine-search hint shown when the cap is hit.
9. **Customer screens read accounts data read-only (Inv. #11; cm20, cm22)** — `tests/guardrails/customer-accounts-read-boundary.test.ts` and `tests/guardrails/customer-accounts-binding-boundaries.test.ts`: no file under `app/(app)/customers/**` or `components/customers/**` imports an Accounts mutation action (only onboarding, its `get-wizard-options` read, and the template reset are allowed), `post-document`, pgledger, the Accounts reversal UI or any billing service/action; the three new Accounts read services (`get-customer-accounts-summary`, `list-customer-billing-accounts`, `resolve-ban-template-label`) import no action, `post-document`, `pgledgerCreateTransfers` or posting-time resolver.
10. **Posting never reads the BAN template reference (Inv. #18; cm22)** — `tests/guardrails/customer-accounts-binding-boundaries.test.ts`: no file under `services/billing/**`, `db/repositories/billing/**` or `workflow-management/**` pairs `billingAccount` with `refBillTemplateVersionId` or contains `billing_account.ref_bill_template_version_id` (`customer_bill`'s own stamp stays allowed); `assertBindableTemplate` is defined once and called only by onboarding and the reset service; the column is written only by onboarding's BAN insert and `billingAccountRepository.setTemplateRef`. The chained flow is proved end to end by `tests/e2e/customer-accounts-journey.integration.test.ts` (DB-gated).

    > **Amended 2026-10-25 (Invoice Template Types; planned).** On ship, this guardrail is rewritten as **§10 guardrail 11**. `ref_bill_template_version_id` no longer exists, and Billing gains exactly two sanctioned references to the new `ref_bill_template_family_id`: the run-start capture read (`listBanFamilies`) and the retire bulk switch (`template-types.ts`). Until then it stands as written.

---

## 10. Invoice Template Types update — code-standards deltas (2026-10-25; planned, not built)

_**Planned.** The Customer Management part is in `custmgmt-update-overview.md`; invariants **#19–#22** are in `custmgmt-architecture.md` §6 and §8. Billing's own rules for the shared pieces are in `billmgmt-code-standards.md` › Invoice Template Types. This section records only what changes in Customer Management. Where it conflicts with §1–§9, this section wins once the update ships._

### General rules (adds to §1)

1. **`NULL` is Standard, always.** Every Customer Management path that writes a BAN's type writes `null` for Standard. No code compares a type id to Standard's id; it checks for `null`. An explicit Standard id is rejected (`TEMPLATE_NOT_BINDABLE`) (Inv. #19, #20).
2. **One validator.** `assertBindableTemplate` is defined once in `services/accounts/assert-bindable-template.ts`, and called only by `onboard-customer-accounts.ts` (always `null`) and `set-billing-account-template.ts`.
3. **Lock inside the caller's transaction.** `assertBindableTemplate(tx, typeId)` takes the caller's `tx` and calls Billing's `lockTemplateType(tx, typeId, 'share')` **before** reading usability, so the check and the BAN update commit together. It never opens its own transaction (Inv. #20).
4. **Read Billing through repositories only.** `services/accounts/**` may import `db/repositories/billing/bill-template-family.ts` and `bill-template-version.ts` (reads plus `lockTemplateType`). No file under `services/accounts/**`, `app/(app)/customers/**` or `components/customers/**` imports `services/billing/**` or `actions/billing/**` (Inv. #11, #22).
5. **The label is computed, never stored.** `resolveBanTemplateLabel` runs per request; no column, cache or client state holds a label (Inv. #21).
6. **Never touch bill-run stamps.** Binding writes only `billing_account`. It reads and writes nothing in `bill_run_account` or `customer_bill`.

### TypeScript conventions (adds to §2)

1. **The value type** is `typeId: string | null` everywhere on the bind path (schema, service, action, panel). The name `billTemplateVersionId` is removed from these files.
2. **`BindableTemplateType`** = `{ typeId: string | null; name: string }`. `listBindableTemplateTypes()` returns `BindableTemplateType[]` with Standard (`typeId: null`, `name: "Standard (default)"`) first, then usable types by `name` ascending.
3. **`BanTemplateLabel`** = `{ kind: "STANDARD" | "TYPE" | "NOT_USABLE"; text: string; name: string; versionNo: number | null }`. Components pick styling from `kind` and render the mono `v{N}` from `versionNo`, never by parsing `text`; `text` is the full string for accessible names and tests.
4. **Result codes stay** `BAN_NOT_FOUND | BAN_CLOSED | CONFLICT | TEMPLATE_NOT_BINDABLE` (plus the action's `FORBIDDEN | VALIDATION_ERROR`). No new code.

### Next.js rules (adds to §3)

1. **`/customers/manage/[id]`** loads `listBindableTemplateTypes()` in the existing `Promise.all` with the BAN list, and passes it to `BillingAccountPanel`. A failure of either read renders `AccountsUnavailableCard` inside the panel, as today.
2. **The save** calls the existing `set-billing-account-template` Server Action with `{ partyRoleId, billingAccountId, typeId, lastModified }`, then `revalidatePath` on the manage and view routes. On `TEMPLATE_NOT_BINDABLE` the panel shows the retired-type message and calls `router.refresh()`.
3. **No new route, page or Route Handler.**

### Styling (adds to §4)

1. **`TemplateTypeSelect`** uses the shadcn/ui `Select`, with options from `listBindableTemplateTypes()`, labelled **"Invoice template type"**. It shows one row per open BAN, inside `BillingAccountPanel`.
2. **Save** is a secondary button labelled **"Save"**, enabled only when the selection differs from the BAN's current type and the viewer holds `accounts_transactions : EDIT`. One save runs at a time, as for the delivered reset.
3. **Panel copy**, defined once in `components/customers/billing-account-messages.ts`:
   - **Caption:** "Changes apply from the next bill run start or rerun."
   - **Retired-type message:** "This invoice template type is no longer available. It may have been retired. The account's current type has been reloaded."
   - **Onboarding field:** label "Invoice template type", value "Standard (default)", help text "New billing accounts use the Standard invoice template. Choose another type afterwards in Manage Customer › Billing account."
4. **Label styling** by `BanTemplateLabel.kind`: `STANDARD` and `TYPE` use the delivered neutral label tokens; `NOT_USABLE` uses the warning family, with an icon, never colour alone. Exact tokens are in `custmgmt-ui-context.md` §10.
5. **Removed copy:** "Reset to follow active template", "Already following the active template", "Follows active template (currently: … vN), as of now", "Template reference not supported yet".

### API routes (adds to §5)

None. The bind stays a Server Action.

### Data and storage rules (adds to §6)

1. **The migration is new and additive.** Add `ref_bill_template_family_id` with its FK; `RAISE EXCEPTION` if any `ref_bill_template_version_id IS NOT NULL`; then drop that column and its FK. Never edit `0050`.
2. **It ships in one merge with Billing's capture change,** so no caller ever reads the dropped column. Both units' specs say so.
3. **The BAN compare-and-set is unchanged** (`billingAccountRepository.setTemplateRef` on `last_modified`). It now writes the type column, and still never bumps `party_role.last_modified_datetime` (Inv. #17).
4. **The audit payload:** `BILLING_ACCOUNT_TEMPLATE_CHANGED` `beforeData`/`afterData` = `{ refBillTemplateFamilyId, typeName }`. Customer Management never sets `reason`; only Billing's retire switch does.
5. **No index** on the new column.

### File organization (adds to §7)

```
services/accounts/
  assert-bindable-template.ts        # CHANGED: null or usable type under FOR SHARE
  set-billing-account-template.ts    # CHANGED: typeId | null
  onboard-customer-accounts.ts       # CHANGED: type reference field, always null
  list-bindable-template-types.ts    # NEW: Standard first, then usable types (Billing repository read)
  resolve-ban-template-label.ts      # CHANGED: type label
  list-customer-billing-accounts.ts  get-customer-accounts-summary.ts   # CHANGED: type id + label
actions/accounts/set-billing-account-template.ts                       # CHANGED: schema only
validation/accounts/
  set-billing-account-template.schema.ts  onboard-customer-accounts.schema.ts   # CHANGED
components/customers/
  billing-account-panel.tsx          # CHANGED: TemplateTypeSelect + Save replaces Reset
  template-type-select.tsx           # NEW
  billing-account-messages.ts        # NEW: panel and onboarding copy
  billing-account-card.tsx           # CHANGED: TemplateLabel shows the type label
  onboard-accounts-wizard.tsx        # CHANGED: field wording
db/schema/billing/accounts.ts        # CHANGED: column swap
db/migrations/<next>_billing_account_template_type.sql                 # NEW
```

### Permission names & per-page permission map (adds to §8)

**No new permission and no level change.**

| Surface | Route | Top-level component(s) | Folder | Permission : level |
|---|---|---|---|---|
| Manage Customer: Billing account panel, type label | `/customers/manage/[id]` | `CustomerEditPage` → `BillingAccountPanel` → `TemplateLabel` | `app/(app)/customers/manage/[id]/` | `customers` : **EDIT** (page) |
| Bind / rebind a BAN's type | same page | `BillingAccountPanel` → `TemplateTypeSelect` + Save → `set-billing-account-template` | `actions/accounts/` | `customers` : **EDIT** + `accounts_transactions` : **EDIT** (re-checked in the action) |
| View Customer: Accounts tab type label | `/customers/view/[id]?tab=accounts` | `CustomerAccountsTab` → `BillingAccountCard` → `TemplateLabel` | `app/(app)/customers/view/[id]/` | `customers` : **READ** + `accounts_view` : **READ** |
| Onboarding "Invoice template type" field | `/customers/manage/[id]` (wizard) | `OnboardAccountsWizard` | `components/customers/` | existing dual guard (unchanged) |

The authz matrix gains: a `customers : EDIT`-only user's bind is refused server-side; a READ-only user can't reach the panel; a user without `accounts_view : READ` sees no label on the Accounts tab.

### Guardrail tests (extends §9, items 11–13)

11. **Template-column boundary (replaces item 10 on ship).**
    - No file anywhere references `ref_bill_template_version_id` on `billing_account`.
    - Under `services/billing/**`, `db/repositories/billing/**` and `workflow-management/**`, `ref_bill_template_family_id` on `billing_account` appears **only** in `listBanFamilies` (read) and `services/billing/invoice-template/template-types.ts` (the Bound BANs count and the retire switch).
    - `assertBindableTemplate` is defined once and called only by onboarding and `set-billing-account-template.ts`.
    - No customer-tree file imports `services/billing/**` or `actions/billing/**`.
12. **Bind gate.**
    - `null` binds Standard.
    - A usable type binds: one update, one audit row with type names, the BAN's `last_modified` bumped, `party_role.last_modified_datetime` untouched.
    - Each of these returns `TEMPLATE_NOT_BINDABLE`, writes nothing and audits nothing: Standard's id, an unknown id, a retired type, a not-yet-usable type.
    - `CONFLICT`, `BAN_CLOSED`, `BAN_NOT_FOUND` and unchanged-value no-op behave as before.
    - The CM half of Billing's parallel test (billing guardrail 76): a bind racing a retire commits first and is switched, or fails.
13. **Panel and labels.**
    - The select lists Standard first, then usable types; retired and not-yet-usable types are absent.
    - Save is disabled when unchanged and for a `customers : EDIT`-only user.
    - The retired-mid-edit save shows the agreed message and reloads.
    - Labels render "Standard (default) · vN" and "{type} · vN", and "· not usable" with the warning style.
    - None of the four removed strings (Styling rule 5) exists in the source.
    - Onboarding still writes `null`, and the V7 rollback test passes.

### Rules superseded by this update

| Rule | Was | Now |
|---|---|---|
| §4 rule 5 (Manage Customer panel) | Reset to follow active template; enabled only for an open, non-`NULL` BAN. | `TemplateTypeSelect` + Save (Styling rules 1–3). |
| §7 `assert-bindable-template.ts` | "v1 NULL-only". | `null` or a usable type under `FOR SHARE` (General rules 1–3). |
| §8 note "Billing account template reset (cm21)" | Reset writes `NULL` only. | Bind writes `null` or a type id; same dual guard. |
| §9 guardrail 10 | Posting never reads the column; no Billing file references it. | Item 11: Billing references the new column in exactly two places. |
