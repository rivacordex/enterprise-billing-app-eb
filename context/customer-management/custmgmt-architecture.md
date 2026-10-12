# Customer Management — Architecture (Module)

This document builds on `context/architecture.md`, which owns the platform-wide design — stack, folder ownership, multi-module database design, the auth/authorization platform, and platform invariants — and records **only what the Customer Management module adds or changes**. Anything not stated here is inherited unchanged. Key decisions are canonical in `_newmodule-customer-mgmt-plan.md`; the product spec (user flows, data model, features) is in `custmgmt-project-overview.md`; the planned Invoice Template Binding update is in `custmgmt-update-overview.md` and `_updatemodule-customer-accounts-invoice-template-binding-plan.md`.

**Status:** PLANNED — decisions agreed 2026-07-06, amended 2026-07-09 (flattened contact model), pre-implementation. Changes to _Module Invariants_ require a documented design review. **Update planned (2026-10-10):** Invoice Template Binding, see §7 and `custmgmt-update-overview.md`.

**Scope:** v1 is full CRUD (create/update/soft-delete) for enterprise customers behind two pages — **View Customer** (search + read-only detail, USER + MANAGER + ADMIN) and **Manage Customer** (search + edit + add new, MANAGER + ADMIN) — under a new "Customer" nav section. No accounts, invoicing, credit checks, external/TMF APIs, or merge tooling this release.

---

## 1. Technology Stack — Deltas Only

The stack is inherited wholesale from `architecture.md` §1. This module introduces **no new stack components** — Next.js (App Router, Server Actions), Drizzle ORM + Postgres, Better-Auth + existing RBAC tables, shadcn/radix UI, vitest, Zod. Module-specific usage notes:

| Layer              | Technology (inherited)       | This module's usage / delta                                                                                                                                                                                                                         |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend           | Next.js App Router, RSC      | Two pages, each search-first with empty start state; status dropdowns are server-driven from the transition maps (§Module Invariants), never hard-coded client-side.                                                                                |
| APIs & Backend     | Server Actions + `services/` | Full CRUD via Server Actions this release (unlike Product's read-only v1): create, update, status-transition, contact add/update/delete, set-preferred (contact and method) — each wraps validate → mutate → audit in one transaction.              |
| Database           | PostgreSQL ≥ 16, Drizzle     | New **`customer` schema** (platform §4 namespacing — already anticipated by name in `architecture.md` §4). Second module to use JSONB (`party_role.party_role_specification`), but with a **narrower validation contract** than Product's — see §3. |
| Auth & Permissions | Better-Auth + core RBAC      | One new code-seeded permission: `customers`. No auth mechanics change.                                                                                                                                                                              |
| Validation         | Zod in `validation/`         | Schemas for org/role/contact field shapes, transition-map edges, and JSON well-formedness (not shape) for `party_role_specification`.                                                                                                               |
| Everything else    | —                            | Unchanged: hosting, CI/CD, monitoring, backup/recovery, no cache, no RLS, no rate limiting.                                                                                                                                                         |

---

## 2. System Boundaries — Folder Ownership Deltas

Dependency rule unchanged (UI → actions → services → repositories → DB; inner layers never import outward).

| Path                          | Owns                                                                                                                                                                                                                                   | Notes                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `app/(app)/customers/view/`   | Search page (`/customers/view`) + read-only detail (`/customers/view/[id]`). Declares `customers : READ`.                                                                                                                              | Three read-only sections: Party – Organization, Role – Customer, Customer – Contact Details.                                  |
| `app/(app)/customers/manage/` | Search page (`/customers/manage`) + edit (`/customers/manage/[id]`) + add-new (`/customers/manage/new`). Declares `customers : EDIT`.                                                                                                  | No DB queries, no raw SQL, thin orchestrators composing `components/` (platform §2).                                          |
| `components/admin-nav.tsx`    | Adds a "Customer" section to `NAV_SECTIONS`: View Customer, Manage Customer.                                                                                                                                                           | Nav renders regardless of permission; Manage Customer shows greyed/locked for USER (page guard enforces access, not the nav). |
| `actions/customer/**`         | Server Actions: create, update, status-transition, contact CRUD, set-preferred (contact + method). Resolve principal, check `customers` permission + level, call a service.                                                            | No business rules beyond orchestration (platform §2).                                                                         |
| `services/customer/**`        | Use cases: search, detail assembly, create, update, transition validation, contact mutation, preferred-pointer maintenance, optimistic-lock check. Framework-agnostic.                                                                 | No `next/*` imports.                                                                                                          |
| `db/**` (customer scope)      | Drizzle schema for the `customer` schema: `organization`, `party_role`, `contact_medium`; migrations; per-entity ID sequences; the `customers` PERMISSIONS row; the `CUSTOMER_SEARCH_RESULT_LIMIT` `SYSTEM_CONFIG` seed; repositories. | Only place SQL lives.                                                                                                         |
| `validation/customer/**`      | Zod schemas for org/role/contact fields, status-reason requirement, JSON-well-formedness check for `party_role_specification`.                                                                                                         | Parsed before any service call.                                                                                               |
| `tests/**`                    | Unit/integration tests for transition-map edges, preferred-contact/method invariants, uniqueness, optimistic locking + **authz-matrix entries** for both new routes.                                                                   | New pages must appear in the matrix before ship (platform §5).                                                                |

---

## 3. Storage Model

All in Postgres, `customer` schema; no file storage or cache (platform §3). Column detail is in the overview's _Data Model_. Shared core (`core.APPUSER`, RBAC, `AUDIT_LOG`, `SYSTEM_CONFIG`) reused, never duplicated (platform §4).

| Data                                   | Where                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization (`customer.organization`) | Postgres                               | Legal entity. `registration_number` nullable-unique (GOVERNMENT orgs may lack one). Status: `REGISTERED → ACTIVE ↔ INACTIVE/SUSPENDED → DISSOLVED/MERGED` (terminal). Never physically deleted.                                                                                                                                                                                                                   |
| Customer role (`customer.party_role`)  | Postgres                               | One row per customer engagement on an org. Status: `INITIALIZED → VALIDATED → ACTIVE ↔ SUSPENDED → CLOSED` (terminal). `party_role_specification` **JSONB** — structurally validated (valid JSON only), no enum/key enforcement (accepted risk, see Inv. #7). `account` column is display-only, nullable, no FK; customer account lookup belongs to the Accounts module via `financial_account.ref_party_role_id` (Inv. #9, #13). `last_modified_datetime` drives optimistic locking (Inv. #5). |
| Contacts (`customer.contact_medium`)   | Postgres                               | **Flattened**, one row per contact person, inline `phone_*`, `email_*`, `ga_*` (address) columns, `preferred_contact_method` enum. Max one phone/email/address per contact — a second number needs a second row. The **only** rows in this module that are ever physically deleted (except the pointed-at preferred contact, Inv. #4).                                                                            |
| Preferred pointers                     | Postgres                               | `party_role.contact_medium` → preferred contact (nullable, composite deferrable FK to `(id, ref_party_role)`); `contact_medium.preferred_contact_method` → preferred channel (nullable enum). Uniform pointer design, no `preferred` booleans.                                                                                                                                                                    |
| IDs                                    | Postgres sequences                     | Prefix + zero-padded sequence per platform §3: `ORG` (organization), `PTRL` (party role), `CTMD` (contact medium) — e.g. `ORG0000001`, `PTRL00000001`, `CTMD00000001`.                                                                                                                                                                                                                                            |
| Search limit                           | `core.SYSTEM_CONFIG`                   | `CUSTOMER_SEARCH_RESULT_LIMIT`, default `5`, `config_group = customer`.                                                                                                                                                                                                                                                                                                                                           |
| Provenance                             | `last_modified_by` FK → `core.APPUSER` | Added to `organization`, `party_role`, `contact_medium` (platform §4 provenance-column pattern).                                                                                                                                                                                                                                                                                                                  |
| Audit                                  | `core.AUDIT_LOG`                       | Every mutation (create/update/status-change/contact CRUD/set-preferred) writes one entry; status changes additionally persist `status_reason` on the row itself.                                                                                                                                                                                                                                                  |

---

## 4. Authentication & Access Model

Auth mechanics unchanged (platform §5: Better-Auth sessions, live per-request permission resolution, 3-layer defense in depth). Module specifics:

- **Single `customers` permission**, page-level, code-seeded via migration. **READ** = View Customer (search + read-only detail). **EDIT** = Manage Customer (create, update, all status transitions, contact CRUD, set-preferred). No **DELETE** level is seeded for this module — "delete" is a status transition (`customers : EDIT`), and contact hard-delete is also an EDIT-gated action, not a separate delete permission.
- Page guards: `requirePermission('customers', 'READ')` at `/customers/view/**`; `requirePermission('customers', 'EDIT')` at `/customers/manage/**`. No grant → `/no-access` (deny by default).
- USER holds `customers:READ` only — Manage Customer renders greyed/locked in the nav; direct Server Action calls to manage endpoints are rejected server-side independent of the nav state (platform §5, defense in depth).
- MANAGER holds `customers:READ` + `customers:EDIT`.
- ADMIN holds `customers:EDIT` (implying READ) — mirrors Product Management's ADMIN grant (`pm02`) so an administrator has working access to every business module out of the box, not just the platform-admin modules (Users/Roles/System Config/Audit Log). Retroactive correction to this unit's original design, which specified grants for MANAGER/USER only and never considered ADMIN — see `custmgmt-progress-tracker.md`'s `cm01` entry.

### Permission matrix additions

| Page (route)                                                                                                  | Access        | Required permission : level |
| ------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------- |
| `/customers/view`, `/customers/view/[id]`                                                                     | Authenticated | `customers` : **READ**      |
| `/customers/manage`, `/customers/manage/[id]` — create, edit, status transitions, contact CRUD, set-preferred | Authenticated | `customers` : **EDIT**      |
| `/customers/manage/new` — add new customer                                                                    | Authenticated | `customers` : **EDIT**      |

---

## 5. Background Tasks & AI

**None.** No AI/ML components (platform §6 stands). No standalone jobs — optimistic-lock checks and status-transition validation happen per-request, not as background work. New audit event types under the existing `core.AUDIT_LOG` schema (discriminated by `event_type`/`target_entity`, platform §4): organization/party_role create & update, status-change events per entity, contact create/update/delete, preferred-contact-changed, preferred-method-changed.

**No email/SMTP** in v1 (platform §6 stands).

---

## 6. Module Invariants

Platform Invariants (`architecture.md` §7) all apply. Additional rules this module must never violate; each is testable and CI-enforceable:

1. **Soft delete only.** `organization` and `party_role` rows are never physically deleted — "delete" is Customer → `CLOSED` and Organization → `DISSOLVED` via the transition maps. `contact_medium` rows are the module's only physical deletes, and only when not the pointed-at preferred contact (Inv. #4).
2. **Status transitions are server-enforced against the signed-off maps**, and every transition requires a non-null `status_reason`. The UI status control is generated from the map, never hand-authored; a transition absent from the map is rejected even if submitted directly to the Server Action.
3. **At most one non-closed customer role per organization.** Enforced by a partial unique index (`UNIQUE (engaged_party) WHERE status != 'CLOSED'` on `party_role`), not app logic alone. A returning closed customer gets a new `party_role` row under the same org; `CLOSED` is terminal and never reopened.
4. **Exactly one preferred contact per customer when any contacts exist.** `party_role.contact_medium` is NULL iff the customer has zero contacts; the first contact added is auto-preferred; deleting the pointed-at contact is blocked until another is made preferred first — so a customer with ≥1 contact never drops to zero.
5. **Exactly one preferred contact method per contact.** `contact_medium.preferred_contact_method` must name a currently-populated method and is NULL iff no method is populated; the first method filled in is auto-preferred; clearing the preferred method is blocked while another method is still populated.
6. **Customer-level optimistic locking.** Any mutation within a customer (org fields, role/status, contacts, set-preferred) compares and bumps `party_role.last_modified_datetime` in the same transaction as the mutation; a stale-copy save is rejected, not silently overwritten.
7. **`party_role_specification` JSONB is an explicit, accepted exception to the platform's default JSONB rule** (`architecture.md` §3: "no junk-drawer JSONB"). This column is validated only for well-formed JSON — no enum or key-level enforcement; `CUST_TYPE`, `CUST_KEY`, `PARTY_TYPE` are free custom values, editable anytime. `CUST_KEY` uniqueness/immutability is operator discipline only, by user decision — revisit if an external system later keys on it.
8. **`registration_number` is nullable-unique** — enforced by a DB constraint, not just app validation, so GOVERNMENT orgs (which may lack one) don't collide with each other while COMPANY orgs can't collide on a real one.
9. **`party_role.account` stays display-only.** No FK, no create/edit UI, and never used for customer account lookup. The Accounts module owns that lookup through `financial_account.ref_party_role_id` (Inv. #13); this module must not invent its own account linkage logic.
10. **Customer tables live in the `customer` schema** and reference the shared core by FK (`last_modified_by` → `core.APPUSER`). The module creates no user, role, permission, session, config, or audit tables (platform Inv. #10 restated for emphasis).

**Added — Invoice Template Binding update (2026-10-10; rules for §7):**

11. **The customer screen reads accounting data one-directionally and read-only.** `app/(app)/customers/**` and `components/customers/**` may import only the Accounts read services (`getCustomerAccountsSummary`, `listTransactionDocuments`, the template-label resolver). They may not import any `actions/accounts/**` mutation, `post-document`, a pgledger function, or a billing write path. Enforced by a boundary guardrail test in the style of `billing-trial-bill-compute-boundary`. The Accounts tab has no posting, reversal or transaction actions; a mutating task is a deep-link into the Accounts module.
12. **The Accounts tab composes two permissions and adds no third.** The page guard stays `customers : READ`; the tab's content additionally needs `accounts_view : READ`, read once from the `permissionMap` that `requirePermission` returns. Without it the tab renders a locked card and **fetches nothing**. No new `PERMISSIONS` row (platform Inv. #6 is untouched).
13. **A customer's accounts are found through the account side's party-role key, never through `party_role.account`.** `getCustomerAccountsSummary(partyRoleId)` resolves the Financial Account by `financial_account.ref_party_role_id` and its BANs from there. `party_role.account` stays display-only with no FK (Inv. #9 unchanged).
14. **View Customer tabs are URL state on a server component.** `?tab=profile|contacts|accounts` (default `profile`; an unknown value falls back to `profile`). The page stays guard-first with one all-or-nothing not-found state, the three existing section components and `metadata.title` are unchanged, and the `InconsistencyBanner` renders **above** the tab strip so it shows on every tab under the unchanged `isStatusInconsistent` rule.
15. **Accounts data loads only for the active Accounts tab, and balances are never cached or stored.** The queries run in an async child under Suspense when `tab=accounts`; Profile and Contacts issue no ledger, balance or document query. Balances for all of the customer's BANs come from one `billing.account_view` read (no per-BAN loop) and are always read live (platform Inv. #15).
16. **The Manage Customer "Billing account" panel is UX; the action is the gate.** The page guard stays `customers : EDIT`. The panel is enabled only when the viewer holds `accounts_transactions : EDIT` and is otherwise read-only with the `EDIT_DISABLED_TITLE` tooltip. `set-billing-account-template` re-checks **both** `customers : EDIT` and `accounts_transactions : EDIT` server-side (platform Inv. #3).
17. **A template reset is a BAN change, not a customer-record change** (decided 2026-10-10). It is guarded by the BAN's own lock (`findStateByIdForUpdate` + `billing_account.last_modified`), writes its own audit event, and does **not** bump `party_role.last_modified_datetime`. Inv. #6 keeps governing org, role, status and contact mutations; onboarding still locks the party role because it changes the customer's status.
18. **The customer screen never implies a template binding the invoice does not use.** In v1 the column accepts `NULL` only and posting ignores it. The screen shows `NULL` as "Follows active template (currently: <name> vN), as of now" (a live lookup, never persisted or cached), offers no choice beyond *Follow active template*, and a non-`NULL` value is rejected server-side (`TEMPLATE_NOT_BINDABLE`). Lifting that rule is part of one indivisible Phase 3 change owned with Billing (the Billing architecture's Inv. #51–#54 define the column's meaning).

---

## 7. Invoice Template Binding update — architecture deltas (2026-10-10)

Per the convention at the top of this document, this section extends `context/architecture.md` and §1–§6 and records **only** what the Invoice Template Binding update changes or adds (`_updatemodule-customer-accounts-invoice-template-binding-plan.md`, decisions D1–D16; scope in `custmgmt-update-overview.md`). It is **Phase 2 of invoice-template management** and is **plumbing only**: the customer record can show, confirm at onboarding, and reset a per-BAN template reference, and the View Customer page becomes tabbed with an Accounts tab. It introduces **no new technology, no new table, no new permission, no new M2M path and no background job**. New rules are Module Invariants **#11–#18** (§6). The template catalog and the resolver belong to Billing (`billmgmt-architecture.md` §6, Inv. #41–#44); the BAN table and its write services belong to the Accounts module (`acctmgmt-architecture.md`).

### Platform-level deltas (against `context/architecture.md`)

None changes a Platform Invariant. Two bounded first uses for this module:

| `architecture.md`                | Says                                                                                                 | What this update adds for Customer Management                                                                                                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2 Boundaries (inward-only deps) | UI → actions/routes → services → data-access → DB; no outward imports.                                | The customer pages **read the Accounts module's services** (first cross-module read from `app/(app)/customers/**`). Allowed because services are framework-agnostic and the direction is inward; limited to reads (Inv. #11). The module's earlier scope line "no accounts" now means no account *writes*. |
| §5 Per-page access declaration   | Every page declares one permission + level; each action re-resolves the live user and re-checks.     | One page **composes two permissions** (Inv. #12): `customers : READ` for the page, `accounts_view : READ` for one tab. Denied → a locked state, not a redirect, because the rest of the page is permitted.                                                                                          |

### 1. Technology stack: deltas

No new components. Usage notes:

| Layer                  | Technology (inherited)                              | This update's usage                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend               | Next.js App Router, RSC, `searchParams`             | URL-driven tab shell on `view/[id]` (Inv. #14); async child + Suspense for the Accounts tab (Inv. #15); a "Billing account" panel and one wizard field on Manage Customer. No client tab state, no new UI library.       |
| APIs & Backend         | Server Actions + `services/`                        | One new Server Action, `set-billing-account-template`, and one new read service for the tab. Both live under `actions/accounts/**` and `services/accounts/**` (the Accounts side owns the table).                       |
| Database               | PostgreSQL, Drizzle                                 | One nullable column with a real FK on `billing.billing_account` (§7.3). The `customer` schema is unchanged.                                                                                                            |
| Auth & Permissions     | Better-Auth + core RBAC                             | No new permission; existing `customers`, `accounts_view`, `accounts_transactions` combine as in §7.4.                                                                                                                 |
| Validation             | Zod in `validation/`                                | Onboarding schema gains optional `billTemplateVersionId` (`string \| null`, always `null` in v1); a shared `assertBindableTemplate` validates it.                                                                       |
| Testing                | vitest                                              | A rewritten View Customer page test (the old "all three section titles" assertion no longer holds), a panel component test, and one DB-gated service-level journey test (plan §11). Browser e2e is deferred to `_newmodule-playwright-e2e-testing-plan.md`.                                                       |

### 2. System boundaries: deltas

| Path                                                          | Delta                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/(app)/customers/view/[id]/page.tsx`                      | Becomes the tab shell (Inv. #14). Guard stays `customers : READ`. Reads accounts data only through the services below (Inv. #11).                                                                                       |
| `app/(app)/customers/manage/[id]/page.tsx`                    | Guard stays `customers : EDIT`. Loads the customer's BANs and renders the new Billing account panel; passes whether `accounts_transactions : EDIT` is held, for greying only (Inv. #16).                                |
| `components/customers/**`                                     | `onboard-accounts-wizard.tsx` (rendered by `customer-role-form.tsx`) gains the single-option *Invoice template* field; new Billing account panel and Accounts-tab components. Presentational: no DB access, no permission **decisions**. |
| `actions/accounts/set-billing-account-template.ts`            | New. Validate → resolve principal → re-check `customers : EDIT` **and** `accounts_transactions : EDIT` → service → `revalidatePath` (manage and view routes).                                                           |
| `services/accounts/set-billing-account-template.ts`           | New. One `db.transaction`; result codes `BAN_NOT_FOUND`, `BAN_CLOSED`, `CONFLICT`, `TEMPLATE_NOT_BINDABLE`; no write and no audit event when the value is unchanged (Inv. #17).                                        |
| `services/accounts/assert-bindable-template.ts`               | New, shared by onboarding and the reset action; v1 accepts `null` only (Inv. #18).                                                                                                                                      |
| `services/accounts/get-customer-accounts-summary.ts`          | New read service: Financial Account by party role (Inv. #13), BANs, balances from `billing.account_view`, and the template label. Returns the not-onboarded, empty and normal states; the page decides the locked state. |
| `services/accounts/onboard-customer-accounts.ts` + validation | Adds `billTemplateVersionId` and passes it to `billingAccountRepository.insert`; the `ACCOUNTS_ONBOARDED` audit `afterData` gains the field.                                                                           |
| `services/customer/**`, `validation/customer/**`, `db/**` (customer scope) | **No change.** `getCustomerDetail`, the transition maps and the three customer tables are untouched.                                                                                          |
| `tests/**`                                                    | Plan §11 matrix, plus the two boundary guardrails: Inv. #11 (customer pages import no accounts mutation) and the Billing-side guardrail that posting never reads the column.                                            |

### 3. Storage model: deltas

| Data                                    | Where                                  | Delta                                                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template reference on a customer's BAN  | Postgres, `billing.billing_account`    | **+1 nullable column** `ref_bill_template_version_id text`, FK → `billing.bill_template_version`. `NULL` = follow the current ACTIVE template, else the default; "follow the line", kind `generated` only. Existing BANs read back `NULL`; no backfill. Owned by the Accounts module. |
| Customer tables                         | Postgres, `customer` schema            | **No change** to `organization`, `party_role`, `contact_medium`, their IDs, constraints or the search-limit config key.                                                                                                                  |
| Audit                                   | `core.AUDIT_LOG`                       | One new `event_type`, `BILLING_ACCOUNT_TEMPLATE_CHANGED` (before/after); `ACCOUNTS_ONBOARDED.afterData` gains the field. Added to the audit category map.                                                                                |
| Accounts-tab page size                  | `core.SYSTEM_CONFIG`                   | One new key for the transaction-list page size, following the `CUSTOMER_SEARCH_RESULT_LIMIT` convention (open item O3).                                                                                                                  |
| Balances, document list, template label | Read live from Postgres                | Never cached or stored (Inv. #15, #18).                                                                                                                                                                                                 |
| File storage / cache                    | None                                   | **Unchanged.** This update reads and writes no blob.                                                                                                                                                                                    |

### 4. Authentication & access model: deltas

| Surface                                | Guard                                                                  | Notes                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/customers/view/[id]` (page)          | `customers : READ` (unchanged)                                         | Malformed-id and not-found behaviour unchanged.                                                    |
| Accounts tab content                   | `accounts_view : READ`                                                 | Without it: "Requires accounts access", nothing fetched (Inv. #12).                                |
| Onboarding "Invoice template" field    | `customers : EDIT` + `accounts_transactions : EDIT` (existing dual guard) | Validated inside the existing atomic transaction.                                                  |
| Manage Customer panel + reset action   | `customers : EDIT` + `accounts_transactions : EDIT`, re-checked in the action | A user with `customers : EDIT` only sees the panel read-only (Inv. #16).                           |

Role effect: ADMIN and MANAGER (who hold `customers : EDIT`) can reset a BAN's template only if their role also holds `accounts_transactions : EDIT`; USER keeps read-only access and sees the Accounts tab only if the role holds `accounts_view : READ`. The route × level authz matrix gains the new action and the tab's sub-gate in the same change set.

### 5. Background tasks & AI: deltas

**None.** No AI/ML, no new job, flow, scheduler or M2M path. The reset runs synchronously in a Server Action; tab data loads during the request under Suspense. Nothing is added to `workflow-management/**`.

### Open items with an architectural edge

| #   | Item                                                                                                                                                                                         | When                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| O3  | `system_config` key and default for the Accounts-tab document page size.                                                                                                                     | Build spec.                       |
| O4  | Final name of the audit event type (`BILLING_ACCOUNT_TEMPLATE_CHANGED` proposed); align with the audit catalog.                                                                             | Build spec.                       |
| O6  | Phase 3: template-line identifier, CSV binding, mid-run activation behaviour, and lifting the `NULL`-only rule together with the posting change (`TODOS.md`).                               | Phase 3, owned with Billing.      |
| —   | Test baseline: `billmgmt-known-issues.md` §21 and §13 (12 unit and 48 integration failures; DB-gated suites rewrite cluster-level role passwords). New tests run only on a throwaway Postgres marked disposable. | Before sign-off.                  |
