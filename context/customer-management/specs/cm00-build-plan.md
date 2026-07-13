# CM00 — Customer Management Module Build Plan (Units in Build Order)

**Scope:** v1 full CRUD — two pages, **View Customer** (`customers:READ`) and **Manage Customer** (`customers:EDIT`), per `custmgmt-project-overview.md`.
**Sources:** `custmgmt-project-overview.md` (features, flows, scope), `custmgmt-architecture.md` (stack = platform `architecture.md` §1, unchanged; `customer` schema, §2 folders, §3 storage, §4 permission matrix, §6 Module Invariants 1–10), `custmgmt-code-standards.md` (§7 file tree, §8 permission map, §9 guardrail tests), `custmgmt-ai-workflow-rules.md` §2 (dependency order this plan restructures).
**Ordering authority:** `custmgmt-ai-workflow-rules.md` §2's 7-step list, restructured per the five unit-cutting rules: one visible result per unit, one system boundary per unit, just-in-time dependencies, merge always-done-together units, merge units with no standalone visible result.

## How units were cut

The five rules applied:

1. **One visible result per unit** — a migration that introspects cleanly, a page that renders, an action that mutates + audits + is provably inspectable in the DB.
2. **One system boundary per unit** — see the boundary key below. Almost all work in this module sits inside a single **App** boundary (UI + actions + services + validation); the **Database** boundary is its own unit only where nothing else is needed to prove it (the schema migration). Unlike User Management, this module needs no new **Auth** or **Infra** unit — it reuses the platform resolver, guard, and deployment pipeline unchanged (architecture §4; only one new code-seeded `customers` permission row is added, inside the DB unit).
3. **Dependencies just in time** — write-repository functions (insert/update on `organization`, `party_role`, `contact_medium`) are introduced only in the mutation unit that first needs them, not bundled upfront; the `customer` schema, its sequences, and the `CUSTOMER_SEARCH_RESULT_LIMIT` config land only in Unit cm01, ahead of anything that reads or writes them.
4. **Merge always-done-together** — the Manage-edit page container (guard, fetch, optimistic-lock round-trip) is merged with the *first* mutation that lives inside it (`update-organization`, Unit cm08), since a bare page shell with nothing to save has no standalone result; the "add new customer" page is merged with `create-customer` (Unit cm07) for the same reason.
5. **Merge units with no standalone visible result** — Zod field schemas, the transition maps, and the JSON-well-formedness validator have no visible result alone, so they merge into Unit cm02 with the read-only repositories and services they support (`search-customers`, `get-customer-detail`) — the same pattern used for Product's `pm02` (migration/validation/seeds merged) and consistent with the workflow doc's note that *read paths precede mutations*.

**Boundary key:** `DB` = `db/**` schema, migrations, seeds · `APP` = `app/(app)/customers/**`, `components/customers/**`, `actions/customer/**`, `services/customer/**`, `validation/customer/**` · `TESTS` = `tests/**` cross-cutting guardrail/authz sweep.

Per the workflow doc: read paths precede mutations, and each mutation (per code-standards §7 file tree: 9 Server Actions) is its own unit with its own audit event, guardrail test, and optimistic-lock/permission check. Every guarded route ships with its `customers` PERMISSIONS row (already seeded once in Unit cm01 — READ/EDIT only, no DELETE per architecture §4) + code-standards §8 map row + page guard.

---

## Phase 1 — Data foundation

### Unit cm01 — Database foundation: `customer` schema, tables, constraints, permission + config seed
- **Boundary:** DB
- **Builds:** the `customer` Postgres schema; the three tables `organization`, `party_role`, `contact_medium` (flattened, inline `phone_*`/`email_*`/`ga_*` columns, code-standards §6); ID sequences `ORG`/`PTRL`/`CTMD`; the partial unique index `UNIQUE (engaged_party) WHERE status != 'CLOSED'` on `party_role` (Inv. #3); the nullable-unique `registration_number` (Inv. #8); the composite deferrable FK `party_role.contact_medium → contact_medium(id, ref_party_role)` (Inv. #4); `last_modified_by` FK → `core.APPUSER` on all three tables plus `last_modified_datetime` on `party_role` (the module's one optimistic-lock column, Inv. #6); `status_reason` columns on `organization`/`party_role`; the code-seeded `customers` PERMISSIONS row (READ/EDIT only, no DELETE) and typed `PERMISSIONS.CUSTOMERS` constant; the `CUSTOMER_SEARCH_RESULT_LIMIT` `SYSTEM_CONFIG` seed (`config_group = 'customer'`, default `5`).
- **Guardrail tests owned here** (code-standards §9.4): a second non-closed `party_role` for one organization fails at the DB; a duplicate non-null `registration_number` fails at the DB; a `party_role.contact_medium` pointer to another customer's contact fails at the DB (composite FK rejects it).
- **Visible result:** the migration applies cleanly; all three tables, sequences, constraints, the `customers` permission row, and the `CUSTOMER_SEARCH_RESULT_LIMIT` config row are inspectable via Drizzle introspection/psql; the three constraint-violation guardrail tests provably fail as designed.
- **Dependencies:** none (reuses `core.APPUSER`, `core.PERMISSIONS`, `core.SYSTEM_CONFIG`, `core.AUDIT_LOG` from the platform, already in place).

### Unit cm02 — Validation schemas + read repositories + read services
- **Boundary:** APP (data/service layer, no `next/*`)
- **Builds:** `validation/customer/`: `organization.schema.ts`, `party-role.schema.ts`, `contact-medium.schema.ts` field shapes; `transitions.ts` (`ORGANIZATION_TRANSITIONS` / `CUSTOMER_TRANSITIONS` typed `Record`s — the single source every later dropdown and action reads, §1.4); `specification.schema.ts` (well-formed-JSON-only check, Inv. #7 — no shape/enum enforcement, §1.8); read-only repository functions on `organization`/`party-role`/`contact-medium`; `services/customer/search-customers.ts` (partial case-insensitive match on `name`/`trading_name`, capped by `CUSTOMER_SEARCH_RESULT_LIMIT`, refine-search hint) and `services/customer/get-customer-detail.ts` (assembles `OrganizationDetail`, `CustomerRoleDetail`, `ContactRow[]` read models, never raw Drizzle rows, per code-standards §2.5).
- **Guardrail tests owned here** (code-standards §9.8, part of §9.3): search returns correct partial/case-insensitive matches capped at the configured limit with the hint shown when hit; `specification.schema.ts` accepts well-formed JSON and rejects malformed JSON; the transition-map `Record`s contain exactly the signed-off edges from the overview's lifecycle description (no edge added or missing).
- **Visible result:** unit tests demonstrate search filtering/capping and full detail assembly (org + role + contacts) against seeded/test data, with no `next/*` import anywhere in `services/customer`.
- **Dependencies:** Unit cm01 (tables, sequences, permission/config rows).

---

## Phase 2 — Navigation & View Customer (read-only)

### Unit cm03 — Nav: "Customer" section
- **Boundary:** APP (shell component)
- **Builds:** adds a "Customer" section to `NAV_SECTIONS` in `components/admin-nav.tsx` with two items, View Customer and Manage Customer; nav renders regardless of permission (platform convention, code-standards §1.11) — Manage Customer shows greyed/locked for a USER.
- **Visible result:** the sidebar shows the "Customer" section with both items; a USER sees Manage Customer visibly locked; all existing nav sections/behavior unchanged.
- **Dependencies:** Unit cm01 (the `customers` permission must exist for the greyed/locked computation to have something to check against).

### Unit cm04 — View Customer: search page
- **Boundary:** APP
- **Builds:** `app/(app)/customers/view/page.tsx` (`ViewCustomerSearchPage`), guarded `requirePermission('customers', 'READ')`; empty start state, no pre-loaded results; `CustomerSearchPanel` + `CustomerResultsTable` (shared component built once, reused by Manage in Unit cm06, code-standards §4.6); search text in the `q` URL searchParam (code-standards §3.2); `loading.tsx` / `error.tsx`.
- **Guardrail tests owned here** (code-standards §9.1, partial): authz-matrix entry for `/customers/view` — READ passes, no-grant → `/no-access`. (Route corrected to the plural, folder-derived path — `cm03` §2.1 caught a singular/plural typo in `custmgmt-code-standards.md` §8.)
- **Visible result:** a READ-permitted user reaches an empty search box from the nav, searches, and sees capped, correctly-matched results; the search is deep-linkable via `?q=`.
- **Dependencies:** Units cm02 (search service), cm03 (nav link).

### Unit cm05 — View Customer: read-only detail page
- **Boundary:** APP
- **Builds:** `app/(app)/customers/view/[id]/page.tsx` (`CustomerDetailPage`), same READ guard, ID parsed against the `PTRL`/`ORG` Zod format schema before any repository call (code-standards §2.4); the three-section stack — `OrganizationSection`, `CustomerRoleSection` (incl. read-only `account` field and the JSONB specification display), `ContactDetailsSection` — server components, fixed top-to-bottom order (code-standards §4.5); `InconsistencyBanner` (warn-only styling) when org/customer statuses conflict (e.g. ACTIVE customer on a SUSPENDED organization) — warns only, no cascade.
- **Guardrail tests owned here:** an unknown/invalid ID renders the empty-detail state, not an error; the inconsistency banner renders on a deliberately mismatched status pair and stays warn-only (never blocking).
- **Visible result:** selecting a search result (or opening a deep link) shows the full read-only three-section profile, with the mismatch banner firing correctly when applicable.
- **Dependencies:** Unit cm04 (selection wiring), Unit cm02 (`get-customer-detail`).

---

## Phase 3 — Manage Customer: search & create

### Unit cm06 — Manage Customer: search page
- **Boundary:** APP
- **Builds:** `app/(app)/customers/manage/page.tsx` (`ManageCustomerSearchPage`), guarded `requirePermission('customers', 'EDIT')`; reuses `CustomerSearchPanel` + `CustomerResultsTable` from Unit cm04 (no fork); "Add new customer" entry point to Unit cm07's page; `loading.tsx` / `error.tsx`.
- **Guardrail tests owned here:** authz-matrix entry for `/customers/manage` — EDIT passes, USER → `/no-access` both via the nav-gated route and a direct call bypassing the nav. (Plural, folder-derived path — see `cm03` §2.1.)
- **Visible result:** a MANAGER reaches the same empty-start search experience under Manage; a USER hitting the route directly (bypassing the greyed nav) is rejected server-side.
- **Dependencies:** Units cm02, cm04 (shared search components), cm03 (nav link).

### Unit cm07 — Create customer (org + role) + add-new page
- **Boundary:** APP
- **Builds:** `app/(app)/customers/manage/new/page.tsx` (`NewCustomerPage`) → `NewCustomerForm`; the `customers:EDIT` `create-customer` Server Action + `services/customer/create-customer.ts` + write-repository functions on `organization`/`party_role` (introduced here, JIT); org fields (name required, type COMPANY/GOVERNMENT, registration number/tax ID/industry/trading name optional) with statuses locked and displayed as REGISTERED/INITIALIZED (never editable at creation); registration-number-uniqueness block (DB constraint from cm01 surfaced as a clear error) and non-blocking similar-name warning; `SpecificationEditor` for `party_role_specification` (raw JSON, well-formedness feedback mirroring `specification.schema.ts`); `ORG…`/`PTRL…` IDs generated from the cm01 sequences; validate → mutate → audit (`ORGANIZATION_CREATED`/`CUSTOMER_CREATED`) in one transaction; redirects to the Unit cm08 edit page on success.
- **Guardrail tests owned here** (code-standards §9.2, first half; §9.7 first entry): creating with a duplicate `registration_number` is blocked with a clear error; a similar name warns but does not block; a malformed specification payload is rejected; the created row lands at REGISTERED/INITIALIZED with no way to submit a different initial status; an `AUDIT_LOG` row is written with actor/timestamp/before-after.
- **Visible result:** a MANAGER fills the add-new form and creates a customer that appears in search at REGISTERED/INITIALIZED with generated IDs, and lands on the edit page; audited.
- **Dependencies:** Unit cm06 (entry point), Unit cm02 (validation schemas, transitions map for the locked initial-status display), Unit cm01 (constraints, sequences).

---

## Phase 4 — Manage Customer: edit (org, lifecycle, contacts)

### Unit cm08 — Edit page container + update organization (EDIT)
- **Boundary:** APP
- **Builds:** `app/(app)/customers/manage/[id]/page.tsx` (`CustomerEditPage`), guarded EDIT, ID Zod-parsed, fetches the customer and reads `last_modified_datetime` for round-tripping (code-standards §3.4); `OrganizationForm` (first section rendered in the container); the `customers:EDIT` `update-organization` Server Action + service + write-repository functions on `organization` (JIT); optimistic-lock compare-and-bump on `party_role.last_modified_datetime` in the same transaction as the mutation (Inv. #6); a rejected stale save returns the typed `CONFLICT` result and renders the reload-prompt state, never a silent overwrite (code-standards §3.5); audit (`ORGANIZATION_UPDATED`) with before/after.
- **Guardrail tests owned here** (code-standards §9.6 — first landing of this guardrail): two concurrent editors save the same customer; the second save is rejected with `CONFLICT` and the reload-prompt UI, not overwritten.
- **Visible result:** a MANAGER opens the edit page for an existing customer, edits org fields, and saves; a stale second save is rejected with a reload prompt; the change and lock bump are audited.
- **Dependencies:** Unit cm07 (a created customer to edit), Unit cm02 (validation, read services), Unit cm01 (lock column).

### Unit cm09 — Transition organization status (EDIT)
- **Boundary:** APP
- **Builds:** the `customers:EDIT` `transition-organization-status` Server Action + service; `StatusTransitionControl` (the one component rendering any status dropdown, code-standards §4.2) wired into `OrganizationForm` for the `organization` entity kind, options computed server-side from `ORGANIZATION_TRANSITIONS` (Unit cm02) for the record's current status; mandatory non-empty `statusReason`; same optimistic-lock + audit transaction as cm08 (`ORGANIZATION_STATUS_CHANGED`, `status_reason` persisted on the row itself, Inv. #2, code-standards §6.11).
- **Guardrail tests owned here** (code-standards §9.3, org half): every invalid `ORGANIZATION_TRANSITIONS` edge (e.g. `DISSOLVED → ACTIVE`) is rejected server-side even submitted directly to the action; every valid edge without `status_reason` is rejected.
- **Visible result:** a MANAGER transitions an organization's status (e.g. REGISTERED → ACTIVE) with a reason via the dropdown; invalid/reason-less submissions are rejected; audited with the reason persisted on the row.
- **Dependencies:** Unit cm08 (edit page + lock/audit plumbing), Unit cm02 (`ORGANIZATION_TRANSITIONS`).

### Unit cm10 — Transition customer status (EDIT)
- **Boundary:** APP
- **Builds:** the `customers:EDIT` `transition-customer-status` Server Action + service; `CustomerRoleForm` (second section in the edit container) using the same `StatusTransitionControl` for the `customer` entity kind, options from `CUSTOMER_TRANSITIONS`; enforces no skipping VALIDATED; same lock/audit pattern (`CUSTOMER_STATUS_CHANGED`, `status_reason` persisted).
- **Guardrail tests owned here** (code-standards §9.3, customer half): every invalid `CUSTOMER_TRANSITIONS` edge (e.g. `INITIALIZED → ACTIVE`, skipping VALIDATED) is rejected; every valid edge without `status_reason` is rejected.
- **Visible result:** a MANAGER progresses a customer INITIALIZED → VALIDATED → ACTIVE with reasons; INITIALIZED → ACTIVE directly is rejected; audited.
- **Dependencies:** Unit cm08, Unit cm02 (`CUSTOMER_TRANSITIONS`).

### Unit cm11 — Add contact (auto-preferred contact + auto-preferred method)
- **Boundary:** APP
- **Builds:** the `customers:EDIT` `add-contact` Server Action + `services/customer/contact-mutations.ts` (owns all preferred-pointer maintenance, code-standards §7.3) + write-repository functions on `contact_medium` (JIT); `ContactManagerPanel` (third section in the edit container) with its add-contact form (name, contact role, phone/email/address); the first contact added auto-becomes the `party_role.contact_medium` preferred pointer (Inv. #4); the first of phone/email/address filled in auto-becomes `preferred_contact_method` (Inv. #5); `PreferredIndicator` marks both; same lock/audit transaction (`CONTACT_CREATED`, `PREFERRED_CONTACT_CHANGED`/`PREFERRED_METHOD_CHANGED` when auto-set).
- **Guardrail tests owned here** (code-standards §9.5, first half): a customer's first-added contact is always the preferred pointer; a contact's first populated method is always its preferred method; both hold with no UI/action path able to produce a contacts-but-no-preferred or method-but-no-preferred state.
- **Visible result:** a MANAGER adds a contact with phone/email/address; it and its first-filled method show as preferred without a separate action; audited.
- **Dependencies:** Unit cm08 (edit container), Unit cm02.

### Unit cm12 — Update contact (EDIT)
- **Boundary:** APP
- **Builds:** the `customers:EDIT` `update-contact` Server Action + service (extends `contact-mutations.ts`); edits an existing contact's name/role/phone/email/address fields in `ContactManagerPanel`; preserves the current preferred-contact/preferred-method pointers unless a populated method is cleared (blocked while it's the preferred one, same invariant enforced by cm11's logic); same lock/audit transaction (`CONTACT_UPDATED`).
- **Visible result:** a MANAGER edits a contact's details; the change reflects immediately and is audited without disturbing preferred pointers.
- **Dependencies:** Unit cm11 (contact exists, `contact-mutations.ts` scaffolding).

### Unit cm13 — Delete contact (the module's one physical delete)
- **Boundary:** APP
- **Builds:** the `customers:EDIT` `delete-contact` Server Action + service; hard-deletes the `contact_medium` row (Inv. #1's sanctioned exception) unless it is the pointed-at preferred contact, in which case the delete is blocked with a clear message until another contact is made preferred first (Inv. #4); the repository delete function is not reachable without this check passing (code-standards §6.7); same lock/audit transaction (`CONTACT_DELETED`).
- **Guardrail tests owned here** (code-standards §9.5, second half): deleting the currently-preferred contact is blocked; deleting any non-preferred contact succeeds and is audited as a physical delete.
- **Visible result:** a MANAGER deletes a non-preferred contact (it disappears, audited); attempting to delete the preferred contact is blocked with a clear message.
- **Dependencies:** Unit cm11.

### Unit cm14 — Set preferred contact (EDIT)
- **Boundary:** APP
- **Builds:** the `customers:EDIT` `set-preferred-contact` Server Action + service; explicit reassignment of `party_role.contact_medium` among a customer's existing contacts (distinct from cm11's auto-assign-on-first-add path); same lock/audit transaction (`PREFERRED_CONTACT_CHANGED`).
- **Visible result:** with ≥2 contacts on a customer, a MANAGER explicitly re-picks the preferred one; the `PreferredIndicator` moves; audited.
- **Dependencies:** Unit cm11 (≥1 contact must exist; a second contact to switch to is added via the same cm11 action reused).

### Unit cm15 — Set preferred contact method (EDIT)
- **Boundary:** APP
- **Builds:** the `customers:EDIT` `set-preferred-contact-method` Server Action + service; explicit reassignment of a contact's `preferred_contact_method` among its currently-populated methods; clearing/reassigning is blocked while it would leave a populated method un-preferred (Inv. #5); same lock/audit transaction (`PREFERRED_METHOD_CHANGED`).
- **Guardrail tests owned here** (code-standards §9.5, remainder): clearing the preferred method while another method is still populated is blocked; explicit reassignment among ≥2 populated methods succeeds.
- **Visible result:** a MANAGER explicitly switches a contact's preferred method between two populated methods (e.g. phone → email); audited.
- **Dependencies:** Unit cm11.

---

## Phase 5 — Ship gate

### Unit cm16 — Authz-matrix entries + full guardrail sweep
- **Boundary:** TESTS
- **Builds:** the complete authz-matrix (code-standards §9.1) for all five routes (`/customer/view`, `/customer/view/[id]`, `/customer/manage`, `/customer/manage/[id]`, `/customer/manage/new`) × USER/MANAGER, including every `actions/customer/*` Server Action called directly (bypassing the nav) for a USER; the full core-flow guardrail (§9.2) end to end — search → create → add contact (auto-preferred) → add phone/email/address (auto-preferred method) → INITIALIZED → VALIDATED → ACTIVE, REGISTERED → ACTIVE → visible in View Customer, without errors; the audit-trail guardrail (§9.7) confirming every create/update/status-change/contact-CRUD/set-preferred call in Units cm07–cm15 produced its `AUDIT_LOG` row with actor, timestamp, entity, and before/after, and that `last_modified_by` reflects the true last editor everywhere; any guardrail from §9 not already landed with Units cm01–cm15.
- **Visible result:** CI green with all eight code-standards §9 guardrails passing (authz matrix, full core flow, transition-map edges, DB constraints, preferred invariants, optimistic-lock conflict, audit trail, search correctness) — the module's ship gate; `npm run typecheck`, `npm run lint`, and the full vitest suite pass (overview success criterion #9).
- **Dependencies:** Units cm01–cm15.

---

## Dependency graph

```
cm01 (DB foundation)
  ├─► cm02 (validation + read services)
  │     ├─► cm04 (View search) ──► cm05 (View detail)
  │     └─► cm06 (Manage search) ──► cm07 (create-customer + new page)
  │                                        └─► cm08 (edit page + update-organization)
  │                                              ├─► cm09 (transition organization status)
  │                                              ├─► cm10 (transition customer status)
  │                                              └─► cm11 (add contact)
  │                                                    ├─► cm12 (update contact)
  │                                                    ├─► cm13 (delete contact)
  │                                                    ├─► cm14 (set preferred contact)
  │                                                    └─► cm15 (set preferred contact method)
  └─► cm03 (nav) ──► cm04, cm06
                                    all of cm01–cm15 ──► cm16 (authz matrix + guardrail sweep)
```

## Notes

- **Just-in-time introduction:** `customer` schema + sequences + `customers` permission + `CUSTOMER_SEARCH_RESULT_LIMIT` (Unit cm01); transition maps + specification validator (Unit cm02, ahead of any status/spec UI); write-repository functions on each table appear only in the mutation unit that first needs them (`organization` writes in cm07/cm08/cm09, `party_role` writes in cm07/cm10, `contact_medium` writes in cm11–cm15) — no repository function is built before a unit calls it.
- **No `DELETE` permission level anywhere in this plan** — per architecture §4 and code-standards §8, `customers` seeds READ/EDIT only; every "delete" in Units cm09/cm10/cm13 is a status transition or the one sanctioned contact hard-delete, both gated at EDIT.
- **No route-group rename or new Auth/Infra unit needed** — `app/(app)/**` and the Better-Auth/RBAC resolver already exist from prior modules (platform architecture §2, §5); this module only adds one migration-seeded permission row (Unit cm01) and reuses everything else unchanged.
- **Per-unit checklist** (workflow doc §8) applies to every unit above: spec match, green build, tests incl. any guardrails owned there, end-to-end authorization, optimistic lock + audit where mutating, validated input, ordered migration, updated architecture §4 / code-standards §8 permission maps, docs in sync, no forbidden edits (ai-workflow-rules §6), minimal diff.
- **Deferred/out of scope** (do not pull into any unit above without explicit instruction, ai-workflow-rules §3/§5): `party_role.account` linkage, shape validation on `party_role_specification`, MERGED-status migration tooling, multi-value contact fields, individual (person) customers, TMF/external APIs, merge tooling.
