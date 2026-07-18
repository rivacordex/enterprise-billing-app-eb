# Customer Management — Architecture (Module)

This document builds on `context/architecture.md`, which owns the platform-wide design — stack, folder ownership, multi-module database design, the auth/authorization platform, and platform invariants — and records **only what the Customer Management module adds or changes**. Anything not stated here is inherited unchanged. Key decisions are canonical in `_newmodule-customer-mgmt-plan.md`; the product spec (user flows, data model, features) is in `custmgmt-project-overview.md`.

**Status:** PLANNED — decisions agreed 2026-07-06, amended 2026-07-09 (flattened contact model), pre-implementation. Changes to *Module Invariants* require a documented design review.

**Scope:** v1 is full CRUD (create/update/soft-delete) for enterprise customers behind two pages — **View Customer** (search + read-only detail, USER + MANAGER + ADMIN) and **Manage Customer** (search + edit + add new, MANAGER + ADMIN) — under a new "Customer" nav section. No accounts, invoicing, credit checks, external/TMF APIs, or merge tooling this release.

---

## 1. Technology Stack — Deltas Only

The stack is inherited wholesale from `architecture.md` §1. This module introduces **no new stack components** — Next.js (App Router, Server Actions), Drizzle ORM + Postgres, Better-Auth + existing RBAC tables, shadcn/radix UI, vitest, Zod. Module-specific usage notes:

| Layer | Technology (inherited) | This module's usage / delta |
|---|---|---|
| Frontend | Next.js App Router, RSC | Two pages, each search-first with empty start state; status dropdowns are server-driven from the transition maps (§Module Invariants), never hard-coded client-side. |
| APIs & Backend | Server Actions + `services/` | Full CRUD via Server Actions this release (unlike Product's read-only v1): create, update, status-transition, contact add/update/delete, set-preferred (contact and method) — each wraps validate → mutate → audit in one transaction. |
| Database | PostgreSQL ≥ 16, Drizzle | New **`customer` schema** (platform §4 namespacing — already anticipated by name in `architecture.md` §4). Second module to use JSONB (`party_role.party_role_specification`), but with a **narrower validation contract** than Product's — see §3. |
| Auth & Permissions | Better-Auth + core RBAC | One new code-seeded permission: `customers`. No auth mechanics change. |
| Validation | Zod in `validation/` | Schemas for org/role/contact field shapes, transition-map edges, and JSON well-formedness (not shape) for `party_role_specification`. |
| Everything else | — | Unchanged: hosting, CI/CD, monitoring, backup/recovery, no cache, no RLS, no rate limiting. |

---

## 2. System Boundaries — Folder Ownership Deltas

Dependency rule unchanged (UI → actions → services → repositories → DB; inner layers never import outward).

| Path | Owns | Notes |
|---|---|---|
| `app/(app)/customers/view/` | Search page (`/customers/view`) + read-only detail (`/customers/view/[id]`). Declares `customers : READ`. | Three read-only sections: Party – Organization, Role – Customer, Customer – Contact Details. |
| `app/(app)/customers/manage/` | Search page (`/customers/manage`) + edit (`/customers/manage/[id]`) + add-new (`/customers/manage/new`). Declares `customers : EDIT`. | No DB queries, no raw SQL, thin orchestrators composing `components/` (platform §2). |
| `components/admin-nav.tsx` | Adds a "Customer" section to `NAV_SECTIONS`: View Customer, Manage Customer. | Nav renders regardless of permission; Manage Customer shows greyed/locked for USER (page guard enforces access, not the nav). |
| `actions/customer/**` | Server Actions: create, update, status-transition, contact CRUD, set-preferred (contact + method). Resolve principal, check `customers` permission + level, call a service. | No business rules beyond orchestration (platform §2). |
| `services/customer/**` | Use cases: search, detail assembly, create, update, transition validation, contact mutation, preferred-pointer maintenance, optimistic-lock check. Framework-agnostic. | No `next/*` imports. |
| `db/**` (customer scope) | Drizzle schema for the `customer` schema: `organization`, `party_role`, `contact_medium`; migrations; per-entity ID sequences; the `customers` PERMISSIONS row; the `CUSTOMER_SEARCH_RESULT_LIMIT` `SYSTEM_CONFIG` seed; repositories. | Only place SQL lives. |
| `validation/customer/**` | Zod schemas for org/role/contact fields, status-reason requirement, JSON-well-formedness check for `party_role_specification`. | Parsed before any service call. |
| `tests/**` | Unit/integration tests for transition-map edges, preferred-contact/method invariants, uniqueness, optimistic locking + **authz-matrix entries** for both new routes. | New pages must appear in the matrix before ship (platform §5). |

---

## 3. Storage Model

All in Postgres, `customer` schema; no file storage or cache (platform §3). Column detail is in the overview's *Data Model*. Shared core (`core.APPUSER`, RBAC, `AUDIT_LOG`, `SYSTEM_CONFIG`) reused, never duplicated (platform §4).

| Data | Where | Notes |
|---|---|---|
| Organization (`customer.organization`) | Postgres | Legal entity. `registration_number` nullable-unique (GOVERNMENT orgs may lack one). Status: `REGISTERED → ACTIVE ↔ INACTIVE/SUSPENDED → DISSOLVED/MERGED` (terminal). Never physically deleted. |
| Customer role (`customer.party_role`) | Postgres | One row per customer engagement on an org. Status: `INITIALIZED → VALIDATED → ACTIVE ↔ SUSPENDED → CLOSED` (terminal). `party_role_specification` **JSONB** — structurally validated (valid JSON only), no enum/key enforcement (accepted risk, see Inv. #7). `account` column is display-only, nullable, no FK (Account module doesn't exist yet). `last_modified_datetime` drives optimistic locking (Inv. #5). |
| Contacts (`customer.contact_medium`) | Postgres | **Flattened**, one row per contact person, inline `phone_*`, `email_*`, `ga_*` (address) columns, `preferred_contact_method` enum. Max one phone/email/address per contact — a second number needs a second row. The **only** rows in this module that are ever physically deleted (except the pointed-at preferred contact, Inv. #4). |
| Preferred pointers | Postgres | `party_role.contact_medium` → preferred contact (nullable, composite deferrable FK to `(id, ref_party_role)`); `contact_medium.preferred_contact_method` → preferred channel (nullable enum). Uniform pointer design, no `preferred` booleans. |
| IDs | Postgres sequences | Prefix + zero-padded sequence per platform §3: `ORG` (organization), `PTRL` (party role), `CTMD` (contact medium) — e.g. `ORG0000001`, `PTRL00000001`, `CTMD00000001`. |
| Search limit | `core.SYSTEM_CONFIG` | `CUSTOMER_SEARCH_RESULT_LIMIT`, default `5`, `config_group = customer`. |
| Provenance | `last_modified_by` FK → `core.APPUSER` | Added to `organization`, `party_role`, `contact_medium` (platform §4 provenance-column pattern). |
| Audit | `core.AUDIT_LOG` | Every mutation (create/update/status-change/contact CRUD/set-preferred) writes one entry; status changes additionally persist `status_reason` on the row itself. |

---

## 4. Authentication & Access Model

Auth mechanics unchanged (platform §5: Better-Auth sessions, live per-request permission resolution, 3-layer defense in depth). Module specifics:

- **Single `customers` permission**, page-level, code-seeded via migration. **READ** = View Customer (search + read-only detail). **EDIT** = Manage Customer (create, update, all status transitions, contact CRUD, set-preferred). No **DELETE** level is seeded for this module — "delete" is a status transition (`customers : EDIT`), and contact hard-delete is also an EDIT-gated action, not a separate delete permission.
- Page guards: `requirePermission('customers', 'READ')` at `/customers/view/**`; `requirePermission('customers', 'EDIT')` at `/customers/manage/**`. No grant → `/no-access` (deny by default).
- USER holds `customers:READ` only — Manage Customer renders greyed/locked in the nav; direct Server Action calls to manage endpoints are rejected server-side independent of the nav state (platform §5, defense in depth).
- MANAGER holds `customers:READ` + `customers:EDIT`.
- ADMIN holds `customers:EDIT` (implying READ) — mirrors Product Management's ADMIN grant (`pm02`) so an administrator has working access to every business module out of the box, not just the platform-admin modules (Users/Roles/System Config/Audit Log). Retroactive correction to this unit's original design, which specified grants for MANAGER/USER only and never considered ADMIN — see `custmgmt-progress-tracker.md`'s `cm01` entry.

### Permission matrix additions

| Page (route) | Access | Required permission : level |
|---|---|---|
| `/customers/view`, `/customers/view/[id]` | Authenticated | `customers` : **READ** |
| `/customers/manage`, `/customers/manage/[id]` — create, edit, status transitions, contact CRUD, set-preferred | Authenticated | `customers` : **EDIT** |
| `/customers/manage/new` — add new customer | Authenticated | `customers` : **EDIT** |

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
9. **`party_role.account` stays display-only.** No FK, no create/edit UI, until an Account module exists — this module must not invent account linkage logic ahead of that module.
10. **Customer tables live in the `customer` schema** and reference the shared core by FK (`last_modified_by` → `core.APPUSER`). The module creates no user, role, permission, session, config, or audit tables (platform Inv. #10 restated for emphasis).
