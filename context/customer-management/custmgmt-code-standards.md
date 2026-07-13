# Customer Management — Module Code Standards

> **PLANNED** — module-specific delta to `../code-standards.md` (the overarching standards). This file contains **only** Customer Management specifics; everything else (TypeScript, Next.js, styling, API, data, file organization, CI gates) is inherited unchanged and is not restated here. If a rule seems missing, it lives in the general file.

**Companion docs:** `custmgmt-project-overview.md` (product spec) and `custmgmt-architecture.md` (technical design, numbered **Module Invariants**). Where this doc conflicts with the architecture *Invariants*, the **Invariants win** and the conflict is a bug to fix here.

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
   export const ORGANIZATION_TRANSITIONS: Record<OrganizationStatus, readonly OrganizationStatus[]> = {
     REGISTERED: ['ACTIVE', 'DISSOLVED'],
     ACTIVE: ['INACTIVE', 'SUSPENDED', 'DISSOLVED', 'MERGED'],
     INACTIVE: ['ACTIVE', 'SUSPENDED', 'DISSOLVED', 'MERGED'],
     SUSPENDED: ['ACTIVE', 'INACTIVE', 'DISSOLVED', 'MERGED'],
     DISSOLVED: [],
     MERGED: [],
   } as const
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
5. **Three-section detail layout is a responsive stack:** Party – Organization, Role – Customer, Customer – Contact Details, in that order top-to-bottom on narrow viewports, optionally side-by-side on `lg:` and up (general §4.10) — order is fixed, do not reorder per page.
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
10. **`CUSTOMER_SEARCH_RESULT_LIMIT` lives in `core.SYSTEM_CONFIG`**, `config_group = 'customer'`, default `5` — the search service reads it per request; never hard-code the limit in a component or service.
11. **Status changes persist `status_reason` on the row itself, in addition to the atomic `AUDIT_LOG` entry** (module inv. #2, general §1.7) — the reason is queryable directly off `organization`/`party_role`, not only recoverable by reading audit history.
12. **`last_modified_by` (FK → `core.APPUSER`) is required on `organization`, `party_role`, and `contact_medium`** — every repository write sets it from the resolved principal, never left null on an update.

---

## 7. File Organization (module-specific)

Placement per general §7; the module's concrete tree:

```
app/(app)/customers/view/
  page.tsx                    # ViewCustomerSearchPage — guard READ, search, results
  [id]/page.tsx                # CustomerDetailPage — org / role / contacts sections
  loading.tsx
  error.tsx
app/(app)/customers/manage/
  page.tsx                    # ManageCustomerSearchPage — guard EDIT, search, results
  [id]/page.tsx                # CustomerEditPage — org form, role/status, contacts
  new/page.tsx                 # NewCustomerPage — create flow
  loading.tsx
  error.tsx
components/customers/
  customer-search-panel.tsx        # CustomerSearchPanel
  customer-results-table.tsx       # CustomerResultsTable
  organization-section.tsx         # OrganizationSection (read-only)
  customer-role-section.tsx        # CustomerRoleSection (read-only)
  contact-details-section.tsx      # ContactDetailsSection (read-only)
  organization-form.tsx            # OrganizationForm
  customer-role-form.tsx           # CustomerRoleForm
  contact-manager-panel.tsx        # ContactManagerPanel
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
tests/…                         # mirrors source; incl. authz-matrix entries for both routes
```

1. **`services/customer` stays framework-agnostic** — no `next/*` imports (general §3.14).
2. **Transition maps live only in `validation/customer/transitions.ts`.** No page, component, or action re-declares a status's valid next-states.
3. **Contact mutation logic (preferred-pointer maintenance) lives in `services/customer/contact-mutations.ts`**, not scattered across individual action files — `actions/customer/*-contact*.ts` files stay thin orchestrators calling into it.

---

## 8. Permission Names & Per-Page Permission Map

**v1 permission name** (general §8.1): `customers` — single, page-level, code-seeded via migration. **READ** = View Customer (search + read-only detail). **EDIT** = Manage Customer (create, update, all status transitions, contact CRUD, set-preferred). **No `DELETE` level is seeded for this module** — "delete" is a status transition gated at `customers : EDIT`, and contact hard-delete is also EDIT-gated, not a separate delete permission (architecture §4).

Authoritative for v1; mirrors architecture §4. New pages are appended before they ship — a page with no row here is a bug, not "public" (general §1.11).

| Page | Route | Top-level component | Folder | Permission : level |
|---|---|---|---|---|
| View Customer — search | `/customer/view` | `ViewCustomerSearchPage` → `CustomerSearchPanel`, `CustomerResultsTable` | `app/(app)/customers/view/` | `customers` : **READ** |
| View Customer — detail | `/customer/view/[id]` | `CustomerDetailPage` → `OrganizationSection`, `CustomerRoleSection`, `ContactDetailsSection` | `app/(app)/customers/view/[id]/` | `customers` : **READ** |
| Manage Customer — search | `/customer/manage` | `ManageCustomerSearchPage` → `CustomerSearchPanel`, `CustomerResultsTable` | `app/(app)/customers/manage/` | `customers` : **EDIT** |
| Manage Customer — edit (org fields, status transitions, contacts, set-preferred) | `/customer/manage/[id]` | `CustomerEditPage` → `OrganizationForm`, `CustomerRoleForm`, `ContactManagerPanel` | `app/(app)/customers/manage/[id]/` | `customers` : **EDIT** |
| Manage Customer — add new | `/customer/manage/new` | `NewCustomerPage` → `NewCustomerForm` | `app/(app)/customers/manage/new/` | `customers` : **EDIT** |

**Notes**

- Component names are the binding convention; create them exactly so the page ↔ route ↔ component ↔ permission chain stays traceable (general §9).
- A USER holds `customers:READ` only — Manage Customer renders greyed/locked in the nav; the page guard and every `actions/customer/*` Server Action independently reject a USER (defense in depth, architecture §4) even if the nav check is bypassed.
- Deep links (`/customer/view/[id]`, `/customer/manage/[id]`) pass through the same guard as the search pages — the route param grants nothing.

---

## 9. Module Guardrail Tests (CI gate §10.4)

The general test-suite gate includes this module's guardrail tests from *Success Criteria*, all of which must exist before ship:

1. **Authz matrix** — every route in §8 × every role/level combination, including USER on `/customer/manage/**` → no-access, and direct Server Action calls (bypassing the nav) also rejected for USER.
2. **Full core flow** — search → create → add contact (auto-preferred) → add phone/email/address (auto-preferred method) → INITIALIZED → VALIDATED → ACTIVE, REGISTERED → ACTIVE → visible in View Customer, end to end without errors.
3. **Transition-map edges** — every invalid transition (e.g. `DISSOLVED → ACTIVE`, `INITIALIZED → ACTIVE`) is rejected server-side; every valid transition submitted without `status_reason` is rejected — both for every edge in both maps.
4. **DB constraint tests** — a second non-closed `party_role` for one organization fails at the DB; a duplicate non-null `registration_number` fails at the DB; a `party_role.contact_medium` pointer to another customer's contact fails at the DB.
5. **Preferred invariants** — no UI or Server Action path can produce a customer with contacts but no preferred contact, or a contact with a populated method but no preferred method; deleting the preferred contact is blocked until reassigned; clearing the preferred method is blocked while another method is populated.
6. **Optimistic lock conflict** — two concurrent editors on the same customer: the second save is rejected with the `CONFLICT` result and the reload-prompt UI state, not a silent overwrite.
7. **Audit trail** — every create, update, status change, contact CRUD, and set-preferred call produces an `AUDIT_LOG` row with actor, timestamp, entity, and before/after values; `last_modified_by` reflects the true last editor.
8. **Search correctness** — partial, case-insensitive matches on `organization.name` and `trading_name`; result count capped by `CUSTOMER_SEARCH_RESULT_LIMIT` (default 5) with the refine-search hint shown when the cap is hit.
