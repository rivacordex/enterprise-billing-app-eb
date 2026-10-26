# Customer Management — Architecture (Module)

This document builds on `context/architecture.md`, which owns the platform-wide design — stack, folder ownership, multi-module database design, the auth/authorization platform, and platform invariants — and records **only what the Customer Management module adds or changes**. Anything not stated here is inherited unchanged. Key decisions are canonical in `_newmodule-customer-mgmt-plan.md`; the product spec (user flows, data model, features) is in `custmgmt-project-overview.md`; the delivered Invoice Template Binding update and the delivered **Invoice Template Types** update (Customer Management part) are folded into `custmgmt-project-overview.md`; the Types update's owning design is `context/billing-management/billmgmt-project-overview.md` › Invoice Template Types.

**Status:** PLANNED — decisions agreed 2026-07-06, amended 2026-07-09 (flattened contact model), pre-implementation. Changes to _Module Invariants_ require a documented design review. **Update delivered (cm17–cm22, ship gate 2026-10-13; signed off 2026-10-25):** Invoice Template Binding, see §7 and `custmgmt-project-overview.md`. **Update delivered (cm23–cm24, ship gate 2026-10-26, joint with Billing bm85):** Invoice Template Types, Customer Management part, see §8 and `custmgmt-project-overview.md`; invariants #19–#22 built, #18 replaced by #19–#21.

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

11. **The customer screen reads accounting data one-directionally and read-only.** `app/(app)/customers/**` reads Accounts data only through the read services `getCustomerAccountsSummary` (View Customer Accounts tab) and `listCustomerBillingAccounts` (Manage Customer Billing account panel); `components/customers/**` may reuse the Accounts module's presentational pieces (`AmountCell`, `DocStateBadge`, `EDIT_DISABLED_TITLE`). Neither tree may import `post-document`, a pgledger function or the ledger repository, the Accounts reversal UI (`documents-table`, `reversal-dialog`, `reverse-deposit-panel`), any `services/billing/**` or `actions/billing/**` module, or the posting-time template resolver. The only `actions/accounts/**` imports are the sanctioned customer-screen calls: onboarding (`onboard-customer-accounts`, plus its read `get-wizard-options`) and the template reset (`set-billing-account-template`). Enforced by `tests/guardrails/customer-accounts-read-boundary.test.ts` (cm20) and `tests/guardrails/customer-accounts-binding-boundaries.test.ts` (cm22). The Accounts tab has no posting, reversal or transaction actions; a mutating task is a deep-link into the Accounts module.
12. **The Accounts tab composes two permissions and adds no third.** The page guard stays `customers : READ`; the tab's content additionally needs `accounts_view : READ`, read once from the `permissionMap` that `requirePermission` returns. Without it the tab renders a locked card and **fetches nothing**. Document rows link into `/accounts/transactions` only when the viewer also holds `accounts_transactions : READ` (that page's guard); otherwise the ids render as plain text. No new `PERMISSIONS` row (platform Inv. #6 is untouched).
13. **A customer's accounts are found through the account side's party-role key, never through `party_role.account`.** `getCustomerAccountsSummary(partyRoleId, page, pageFinancialAccountId)` and `listCustomerBillingAccounts(partyRoleId)` resolve the Financial Account by `financial_account.ref_party_role_id` and its BANs from there. `party_role.account` stays display-only with no FK (Inv. #9 unchanged).
14. **View Customer tabs are URL state on a server component.** `?tab=profile|contacts|accounts` (default `profile`; an unknown value falls back to `profile`). The page stays guard-first with one all-or-nothing not-found state, the three existing section components and `metadata.title` are unchanged, and the `InconsistencyBanner` renders **above** the tab strip so it shows on every tab under the unchanged `isStatusInconsistent` rule.
15. **Accounts data loads only for the active Accounts tab, and balances are never cached or stored.** The queries run in an async child under Suspense when `tab=accounts`; Profile and Contacts issue no ledger, balance or document query. Per-BAN receivables come from one grouped `pgledger_accounts_view` read (no per-BAN loop); the FA receivable is the sum of those per-BAN values, so the FA total always equals the sum of the BAN cards; unapplied cash and deposits come via `getFinancialAccountDetail`. All are always read live (platform Inv. #15). A failed read renders an in-tab "unavailable" card; the header, tab strip and other tabs survive.
16. **The Manage Customer "Billing account" panel is UX; the action is the gate.** The page guard stays `customers : EDIT`. The panel is enabled only when the viewer holds `accounts_transactions : EDIT` and is otherwise read-only with the `EDIT_DISABLED_TITLE` tooltip. `set-billing-account-template` re-checks **both** `customers : EDIT` and `accounts_transactions : EDIT` server-side (platform Inv. #3).

    > **Amended 2026-10-25 (Invoice Template Types; delivered cm23, 2026-10-26).** The panel's control becomes a per-BAN **Invoice template type** select with **Save**, replacing the Reset button. The gate is unchanged: the same page guard, the same dual re-check in the action, greying for UX only.
17. **A template reset is a BAN change, not a customer-record change** (decided 2026-10-10). It is guarded by the BAN's own lock (a compare-and-set on `billing_account.last_modified` in `billingAccountRepository.setTemplateRef`, the ac16 `close` shape), writes its own audit event, and does **not** bump `party_role.last_modified_datetime`. Inv. #6 keeps governing org, role, status and contact mutations; onboarding still locks the party role because it changes the customer's status.

    > **Amended 2026-10-25 (Invoice Template Types; delivered cm23, 2026-10-26).** Unchanged in principle: binding a BAN to a type is still a BAN change under the BAN's own compare-and-set, with its own audit event, and never bumps `party_role.last_modified_datetime`. The one addition is the type-row lock (Inv. #20).
18. _**Replaced by Inv. #19–#21** (cm23; closed out by cm24, 2026-10-26). The text below is kept as history._ **The customer screen never implies a template binding the invoice does not use.** In v1 the column accepts `NULL` only and posting ignores it. The screen shows `NULL` as "Follows active template (currently: <name> vN), as of now" (a live lookup, never persisted or cached) and any non-`NULL` value as "Template reference not supported yet", offers no choice beyond *Follow active template*, and a non-`NULL` value is rejected server-side (`TEMPLATE_NOT_BINDABLE`). Lifting that rule is part of one indivisible Phase 3 change owned with Billing (the Billing architecture's Inv. #51–#54 define the column's meaning).

    > **Amended 2026-10-25; replaced 2026-10-26 (Invoice Template Types, cm23–cm24).** **This invariant is replaced by Inv. #19–#21.** The binding is real: the column holds a template **type** (`ref_bill_template_family_id`, migration `0054`, which drops `ref_bill_template_version_id`), Billing's run-start capture uses it, and the screen shows the type the next run will capture. The NULL-only rule and the "Template reference not supported yet" label are removed (CM guardrail 13 string scan).

    > **Note 2026-10-15 (billing bm65; history).** Posting still never reads this column. Billing's run-start capture (`billRunAccountRepository.listBanFamilies`, billing Inv #54) is the one sanctioned reader: it maps the BAN's reference to a template family when a run is triggered or rerun. No Customer Management file changed.

**Added — Invoice Template Types update (2026-10-25; built cm23, closed out by the cm24 ship gate 2026-10-26; rules for §8):**

19. **A BAN's invoice template is a type reference, and `NULL` means Standard.** `billing.billing_account.ref_bill_template_family_id` (FK to `billing.bill_template_family`) is the only template reference on a BAN; `ref_bill_template_version_id` no longer exists. Standard is stored **only** as `NULL`. There are exactly three writers:
    - `setBillingAccountTemplate`, through `assertBindableTemplate`
    - onboarding, which always writes `NULL`
    - Billing's retire bulk switch (billing Inv #66)

    No other code path writes the column. _(Built (cm23): `db/migrations/0054_billing_account_template_type.sql`; `services/accounts/assert-bindable-template.ts`, `set-billing-account-template.ts`, `onboard-customer-accounts.ts` (always `NULL`). Tests: `tests/db/billing-account-template-type-migration.integration.test.ts`, `tests/db/billing-account-template-column.integration.test.ts`, `tests/accounts/set-billing-account-template.integration.test.ts`, `tests/accounts/onboard-customer-accounts-template.integration.test.ts`; the writer pins in `tests/guardrails/customer-accounts-binding-boundaries.test.ts` (guardrail 11, with bm83's retire-switch writer).)_
20. **[CRITICAL] Binding is serialised against retire, inside the binding transaction.** `assertBindableTemplate(tx, typeId | null)` accepts `null` without a lock. For a type id it calls Billing's `lockTemplateType(tx, typeId, 'share')` and accepts only a type that exists, isn't retired and has an ACTIVE settings version, within the **same** transaction as the BAN update. An explicit Standard id is rejected (`TEMPLATE_NOT_BINDABLE`). A bind racing a retire therefore either commits before the retire (and is switched by it) or fails; it never leaves a BAN on a retired type. _(Built (cm23): `services/accounts/assert-bindable-template.ts` (`lockTemplateType` `FOR SHARE`, then the `isDefault`, retired and `findActive` checks). Tests: `tests/services/assert-bindable-template.test.ts`, `tests/accounts/set-billing-account-template.integration.test.ts`; the race in both orders in Billing bm83's `tests/db/retire-template-type.integration.test.ts` ("bind first", "retire first"); `tests/e2e/invoice-template-journey.integration.test.ts` block "bm85 + cm24" step 4 (a bind to the retired type is `TEMPLATE_NOT_BINDABLE`).)_
21. **The customer screen shows the type the next bill run will capture, read live.** `resolveBanTemplateLabels` derives the label from the BAN's current type and that type's ACTIVE version on every request, and never caches or stores it:
    - `NULL` → "Standard (default) · vN"
    - a usable type → "{name} · vN"
    - a type that isn't usable → "{name} · not usable", as a warning

    A binding never touches a bill run's captured stamps; the screen states that changes apply from the next run start or rerun. _(Built (cm23); replaces Inv. #18, closed out by cm24 2026-10-26. Code: `services/accounts/resolve-ban-template-label.ts` (`resolveBanTemplateLabels`, `templateLabelFor`), `components/customers/billing-account-card.tsx`, `billing-account-panel.tsx`, `billing-account-messages.ts`. Tests: `tests/services/resolve-ban-template-label.test.ts`, `tests/components/customer-accounts-tab.test.tsx`, `tests/components/billing-account-panel.test.tsx`, `tests/e2e/customer-accounts-journey.integration.test.ts`; after a retire, both label reads show "Standard (default) · vN" in the "bm85 + cm24" journey step 4.)_
22. **Customer Management reads the type catalog; it never manages it.** The customer tree reads types only through `listBindableTemplateTypes` and `resolveBanTemplateLabels` in `services/accounts/`. These call Billing's **repositories** (`bill-template-family`, `bill-template-version`), never `services/billing/**` or `actions/billing/**` (Inv. #11 unchanged). No customer screen creates, uploads, activates, retires or exports a type, or reads layout files. _(Built (cm23): `services/accounts/list-bindable-template-types.ts`, `resolve-ban-template-label.ts`. Tests: `tests/services/list-bindable-template-types.test.ts`; the import pins in `tests/guardrails/customer-accounts-binding-boundaries.test.ts` and `customer-accounts-read-boundary.test.ts`.)_


---

## 7. Invoice Template Binding update — architecture deltas (2026-10-10; delivered cm17–cm22, signed off 2026-10-25)

**Delivered** by cm17–cm22 (ship gate cm22, `custmgmt-progress-tracker.md`) and **signed off 2026-10-25**. The tables below describe the code as built. §8 (Invoice Template Types, delivered cm23–cm24) supersedes the NULL-only rule, the version column and the Reset control.

Per the convention at the top of this document, this section extends `context/architecture.md` and §1–§6 and records **only** what the Invoice Template Binding update changes or adds (`_updatemodule-customer-accounts-invoice-template-binding-plan.md`, decisions D1–D16; scope folded into `custmgmt-project-overview.md`). It is **Phase 2 of invoice-template management** and is **plumbing only**: the customer record can show, confirm at onboarding, and reset a per-BAN template reference, and the View Customer page becomes tabbed with an Accounts tab. It introduces **no new technology, no new table, no new permission, no new M2M path and no background job**. New rules are Module Invariants **#11–#18** (§6). The template catalog and the resolver belong to Billing (`billmgmt-architecture.md` §6, Inv. #41–#44); the BAN table and its write services belong to the Accounts module (`acctmgmt-architecture.md`).

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
| `app/(app)/customers/manage/[id]/page.tsx`                    | Guard stays `customers : EDIT`. Loads the customer's BANs (`listCustomerBillingAccounts`, in the existing `Promise.all`) and renders the new Billing account panel after `ContactManagerPanel`; passes whether `accounts_transactions : EDIT` is held, for greying only (Inv. #16). A failed BAN read is caught in the page and renders `AccountsUnavailableCard` inside the panel, so org, role and contact editing survive. |
| `components/customers/**`                                     | `onboard-accounts-wizard.tsx` (rendered by `customer-role-form.tsx`) gains the read-only *Invoice template* field ("Follow active template", no picker in v1); new Billing account panel and Accounts-tab components. Presentational: no DB access, no permission **decisions**. |
| `actions/accounts/set-billing-account-template.ts`            | New. `requirePermission(customers : EDIT)` → `accounts_transactions : EDIT` from the returned `permissionMap` (else `FORBIDDEN`) → Zod (`VALIDATION_ERROR`) → service → `revalidatePath` (manage and view routes).                |
| `services/accounts/set-billing-account-template.ts`           | New. One `db.transaction`; result codes `BAN_NOT_FOUND`, `BAN_CLOSED`, `CONFLICT`, `TEMPLATE_NOT_BINDABLE`; no write and no audit event when the value is unchanged (Inv. #17).                                        |
| `services/accounts/assert-bindable-template.ts`               | New, shared by onboarding and the reset action; v1 accepts `null` only (Inv. #18).                                                                                                                                      |
| `services/accounts/get-customer-accounts-summary.ts`          | New read service: Financial Account by party role (Inv. #13), BANs, per-BAN receivables in one grouped `pgledger_accounts_view` read (FA receivable = their sum), unapplied cash and deposits via `getFinancialAccountDetail`, one document page per FA, and the template label. Returns the not-onboarded, empty and normal states; the page decides the locked state. |
| `services/accounts/list-customer-billing-accounts.ts`         | New light read for the Manage Customer panel: every BAN of the customer with state, CAS token (`last_modified`), template reference and label. No balances or documents.                                                  |
| `services/accounts/resolve-ban-template-label.ts`             | New. The live template label (`findActive ?? findDefault`, kind `generated`); never calls `resolveTemplate` or `resolveVersionsForPosting` (Inv. #18).                                                                   |
| `services/accounts/onboard-customer-accounts.ts` + validation | Adds `billTemplateVersionId` and passes it to `billingAccountRepository.insert`; the `ACCOUNTS_ONBOARDED` audit `afterData` gains the field.                                                                           |
| `services/customer/**`, `validation/customer/**`, `db/**` (customer scope) | **No change.** `getCustomerDetail`, the transition maps and the three customer tables are untouched.                                                                                          |
| `tests/**`                                                    | Plan §11 matrix, plus the boundary guardrails: `customer-accounts-read-boundary.test.ts` (cm20, Inv. #11) and `customer-accounts-binding-boundaries.test.ts` (cm22: customer screens and the new read services import no mutation path, posting never reads the column, one validator, two writers). End to end: `tests/e2e/customer-accounts-journey.integration.test.ts` (DB-gated, service level). |

### 3. Storage model: deltas

| Data                                    | Where                                  | Delta                                                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template reference on a customer's BAN  | Postgres, `billing.billing_account`    | **+1 nullable column** `ref_bill_template_version_id text`, FK → `billing.bill_template_version`. `NULL` = follow the current ACTIVE template, else the default; "follow the line", kind `generated` only. Existing BANs read back `NULL`; no backfill. Owned by the Accounts module. |
| Customer tables                         | Postgres, `customer` schema            | **No change** to `organization`, `party_role`, `contact_medium`, their IDs, constraints or the search-limit config key.                                                                                                                  |
| Audit                                   | `core.AUDIT_LOG`                       | One new `event_type`, `BILLING_ACCOUNT_TEMPLATE_CHANGED` (before/after); `ACCOUNTS_ONBOARDED.afterData` gains the field. Added to the audit category map.                                                                                |
| Accounts-tab page size                  | `core.SYSTEM_CONFIG`                   | One new key for the transaction-list page size, following the `CUSTOMER_SEARCH_RESULT_LIMIT` convention (open item O3, closed by cm20: `CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE`, default 20).                                                                                                                  |
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
| O3  | **Closed (cm20):** `customer` / `CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE`, default `20`, capped at `100`. | Closed. |
| O4  | **Closed (cm21):** `BILLING_ACCOUNT_TEMPLATE_CHANGED`, category `Change`, in the audit catalog. | Closed. |
| O6  | Phase 3: template-line identifier, CSV binding, mid-run activation behaviour, and lifting the `NULL`-only rule together with the posting change (`TODOS.md`). **Being closed by the Invoice Template Types update (§8):** the template **type** is the line identifier, the `NULL`-only rule is lifted, and Billing's run-start capture reads the binding. Mid-run activation is answered by Billing's run-start freeze. CSV binding stays out of scope. | Closed by Invoice Template Types (cm23–cm24, 2026-10-26). |
| —   | Test baseline: `billmgmt-known-issues.md` §21 and §13 (DB-gated suites rewrite cluster-level role passwords). New tests run only on a throwaway Postgres marked disposable. cm22 ran the posting stamp, default-resolution, version-pinning and render suites green and unchanged; the full-run result is recorded in `custmgmt-progress-tracker.md` (cm22). | Checked at cm22.                  |

---

## 8. Invoice Template Types update — architecture deltas (2026-10-25; delivered cm23–cm24, 2026-10-26)

_**Delivered.** cm23 built these deltas (one merge with Billing bm82), and the cm24 ship gate, joint with Billing bm85, closed them out on 2026-10-26 (evidence in `custmgmt-progress-tracker.md` cm24). The tables below describe the code as built. The Customer Management part is folded into `custmgmt-project-overview.md`. The owning design (template types, upload, activation, retire, export) is Billing's: `context/billing-management/billmgmt-project-overview.md` › Invoice Template Types and `billmgmt-architecture.md` (Invoice Template Types deltas, Inv #59–#68)._

Per the convention at the top of this document, this section extends `context/architecture.md` and §1–§7, and records **only** what the Invoice Template Types update changes for Customer Management. It turns the delivered plumbing into a real binding: a BAN references a **template type**, RevOps chooses it on Manage Customer, and Billing's run-start capture uses it. It adds **no new technology, no new table, no new permission, no new audit event type, no M2M path and no background job**. New rules are Module Invariants **#19–#22** (§6), and Inv. **#16, #17 and #18** carry dated notes.

### Platform-level deltas (against `context/architecture.md`)

None changes a Platform Invariant.

| `architecture.md` | Says | What this update does for Customer Management |
| --- | --- | --- |
| §2 Boundaries (inward-only deps) | UI → actions/routes → services → data-access → DB. | Unchanged direction. `services/accounts/**` now reads two more **Billing repositories** (the type and version repositories) and calls Billing's `lockTemplateType` inside its own transaction. That's a repository-level dependency, the same pattern as the delivered label resolver. No customer file imports a Billing service or action (Inv. #11, #22). |
| §4 Migrations / Inv. #10 | Committed, ordered migrations. | The `billing_account` change is a **new additive migration** that drops `ref_bill_template_version_id` only after asserting every value is `NULL`. The delivered `0050` is never edited. |

### 1. Technology stack: deltas

**None.** The panel uses the existing shadcn/ui `Select` and `Button`; validation stays Zod; tests stay vitest.

### 2. System boundaries: deltas

| Path | Delta |
| --- | --- |
| `db/migrations/0054_billing_account_template_type.sql` and `db/schema/billing/accounts.ts` | `billing_account`: add `ref_bill_template_family_id` (FK to `bill_template_family`), abort on any non-`NULL` `ref_bill_template_version_id`, then drop that column and its FK. The Drizzle mirror follows. It ships in **one merge** with Billing's capture change (`listBanFamilies` stops reading the dropped column). |
| `services/accounts/assert-bindable-template.ts` | Accepts `null` or a usable non-default type id under `lockTemplateType(tx, id, 'share')` (Inv. #20). Still the one validator, called by onboarding and `setBillingAccountTemplate` only. |
| `services/accounts/set-billing-account-template.ts` + `actions/accounts/set-billing-account-template.ts` + `validation/accounts/set-billing-account-template.schema.ts` | The value becomes `typeId: string \| null`. Guards, the BAN compare-and-set, result codes and the no-write-on-unchanged rule are unchanged. The audit before/after carries type id and name. |
| `services/accounts/onboard-customer-accounts.ts` + `validation/accounts/onboard-customer-accounts.schema.ts` | The field is renamed to the type reference and always `null`. The atomic transaction is unchanged. |
| `services/accounts/list-bindable-template-types.ts` | **New** read: "Standard (default)" (`typeId: null`) first, then usable non-default types by name, from Billing's type repository (Inv. #22). |
| `services/accounts/resolve-ban-template-label.ts` | Rewritten to the type label (Inv. #21). It no longer calls `findActive ?? findDefault` on the global version list. |
| `services/accounts/list-customer-billing-accounts.ts`, `services/accounts/get-customer-accounts-summary.ts` | Return the BAN's type id and the new label in place of the version reference. |
| `components/customers/**` | `BillingAccountPanel`: the Reset button is replaced by a per-BAN type `Select` + **Save**, the retired-type message and the "next bill run" caption. `BillingAccountCard`: the "Invoice template type" label. `onboard-accounts-wizard.tsx`: new field wording. All presentational; no DB access and no permission decisions. |
| `app/(app)/customers/manage/[id]/page.tsx` | Loads `listBindableTemplateTypes()` alongside the BANs, in the existing `Promise.all`. The guard is unchanged. |
| `tests/**` | Bind gate, panel, labels, migration abort, the CM half of the bind-vs-retire race, and the updated boundary guardrails (code-standards §10, guardrails 11–13). |

### 3. Storage model: deltas

| Data | Where | Delta |
| --- | --- | --- |
| BAN template reference | Postgres, `billing.billing_account` (Accounts-owned) | `ref_bill_template_version_id` (version FK) is **replaced** by `ref_bill_template_family_id` (type FK; `NULL` = Standard). No backfill (all `NULL`). No index. |
| Customer tables | Postgres, `customer` schema | **No change.** |
| Audit | `core.AUDIT_LOG` | No new event type. `BILLING_ACCOUNT_TEMPLATE_CHANGED` before/after now carries the type id and name, plus an optional `reason`, which Billing's retire switch sets. |
| Type list and labels | Read live from Postgres | Never cached or stored (Inv. #21). |
| File storage / cache | None | **Unchanged.** Customer Management reads no layout file and no blob. |

### 4. Authentication & access model: deltas

| Surface | Guard | Notes |
| --- | --- | --- |
| Manage Customer panel: type select + Save | `customers : EDIT` + `accounts_transactions : EDIT`, re-checked in the action | Greyed for a `customers : EDIT`-only user (Inv. #16, as amended). |
| View Customer Accounts tab: type label | `customers : READ` + `accounts_view : READ` | Unchanged sub-gate (Inv. #12). |
| Onboarding field | Existing dual guard | Still writes `NULL`. |

No new permission and no role change. **Data ownership:**
- **Billing** owns the type catalog.
- **The Accounts module** owns the `billing_account` table.
- **Customer Management** owns the bind service and the screens. The column is written only by the three writers in Inv. #19.

### 5. Background tasks & AI: deltas

**None.** Binding runs synchronously in a Server Action; the usable-type list and labels load in the request.

### Contradictions with existing rules, and how they were resolved (all applied by cm23–cm24)

| # | Existing rule | Conflict with this update | Resolution |
| --- | --- | --- | --- |
| C1 | Inv. #18: the column accepts `NULL` only; posting ignores it; "Template reference not supported yet". | Binding to a type is the update's purpose, and Billing's capture uses it. | Inv. #18 is replaced by Inv. #19–#21 (marked under #18, 2026-10-26). |
| C2 | §7 storage: `ref_bill_template_version_id`, "follow the line", kind `generated`. | The reference becomes a type. | A new migration replaces the column; the type **is** the line. `0050` is untouched. |
| C3 | Inv. #16 / UI: a "Reset to follow active template" button. | Binding needs a choice, not only a reset. | The select + Save replaces the button; "Standard (default)" is the reset. |
| C4 | Inv. #11: customer files never import `services/billing/**`. | The panel needs the usable types, and the bind gate needs Billing's lock. | Reads and the lock go through Billing **repositories** from `services/accounts/` (Inv. #22), the precedent the delivered label resolver set. |
| C5 | Guardrail 10: no Billing file references the BAN's template column. | Billing's capture reads the new column, and its retire switch writes it. | Guardrail 10 is replaced by code-standards §10 guardrail 11, which pins exactly those two Billing references. |
| C6 | Open item O6 "Phase 3 … owned with Billing". | This update is that change. | O6 is closed by this update (row note). |
