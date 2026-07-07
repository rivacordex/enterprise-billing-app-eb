# Product Management — Architecture (Module)

This document builds on `context/architecture.md`, which owns the platform-wide design — stack, folder ownership, multi-module database design, the auth/authorization platform, and platform invariants — and records **only what the Product Management module adds or changes**. Anything not stated here is inherited unchanged. Key decisions are canonical in `_newmodule-product-module-plan.md`; the product spec (user flows, data model, features) is in `prodmgmt-project-overview.md`.

**Status:** PLANNED — decisions agreed 2026-07-03, pre-implementation. Changes to *Module Invariants* require a documented design review.

**Scope:** v1 is a **read-only catalog viewer** at `/products/product-offering` for Billing Operations. Data enters via Drizzle seeds / engineer-run SQL. Schema, services, and permission seeds are CRUD-ready so the editing fast-follow is additive only.

---

## 1. Technology Stack — Deltas Only

The stack is inherited wholesale from `architecture.md` §1 (Next.js ≥ 15 App Router + RSC, Server Actions over `services/`, Azure PostgreSQL via Drizzle, Better-Auth, Container Apps, Azure DevOps, no cache/CDN, no rate limiting). This module introduces **no new stack components**. Module-specific usage notes:

| Layer | Technology (inherited) | This module's usage / delta |
|---|---|---|
| Frontend | Next.js App Router, RSC | All list state (search, filter, sort, page, row selection) lives in **URL searchParams** rendered by RSC — same pattern as Administration pages. Deep-link: `?offering=PRDOFR000001`. No client-side state store. |
| APIs & Backend | Server Actions + `services/` | **No new API surface in v1.** Reads flow RSC page → `services/product` → repositories. Server Actions arrive with the CRUD fast-follow. |
| Database | PostgreSQL ≥ 16, Drizzle | New **`product` schema** (platform §4 namespacing) with 3 tables. First module to use **JSONB** columns (`product_spec_characteristics`, `pricing_characteristics`) — guarded by per-`pricing_model` Zod schemas, not free-form. |
| Auth & Permissions | Better-Auth + core RBAC | One new code-seeded permission: `products`. No auth mechanics change. |
| Validation | Zod in `validation/` | Adds per-`pricing_model` discriminated schemas — tiered requires contiguous, non-overlapping `[{from,to,rate}]` bounds. |
| Everything else | — | Unchanged: hosting, CI/CD, monitoring, backup/recovery, no cache, no RLS. |

---

## 2. System Boundaries — Folder Ownership Deltas

Dependency rule unchanged (UI → actions/routes → services → repositories → DB; inner layers never import outward). Two **platform-level changes** this module delivers, plus its own subfolders:

| Path | Owns | Notes |
|---|---|---|
| `app/(app)/**` | **Route group renamed from `(admin)` → `(app)`** (Decision #10). One group hosts all authenticated modules as plain subfolders (`administration/`, `products/`, later `customers/`, `bill-runs/`). | URL-invisible; touches folder path + `@/app/(admin)/…` imports. Do **first** among UI steps. New route groups only when chrome genuinely differs (cf. `(auth)`). |
| `app/(app)/products/product-offering/` | The four-section read-only page (offerings table, detail, specs, prices). Declares `products : READ` guard. Thin orchestrator composing `components/`. | No DB queries, no raw SQL, no heavy markup (platform §2). |
| `components/admin-nav.tsx` | **Refactor `NAV_ITEMS` → `NAV_SECTIONS`** (caption + items per section). Adds "Products" section, peer of "Administration", one item "Product Offering" (lucide `Package`). | Collapsed-rail and active-state behavior unchanged. Nav renders regardless of permission; the page guard enforces access (platform convention). |
| `services/product/**` | List (search / filter / sort / pagination) and detail (offering + specs + prices) use cases. Framework-agnostic; designed CRUD-ready. | No `next/*` imports. |
| `db/**` (product scope) | Drizzle schema for the `product` schema, migration, seeds (incl. `products` PERMISSIONS row), sequences, constraints, repositories. | Only place SQL lives. Specs + prices load with the selected offering through repositories — no new API surface. |
| `validation/product/**` | Zod schemas for list params and `pricing_characteristics` per `pricing_model`. | Parsed before any service call. |
| `tests/**` | Repo/service unit tests + **authz-matrix entry** for `/products/product-offering`. | New page must appear in the matrix before ship (platform §5). |

No `actions/` or `app/api/` additions in v1 (read-only).

---

## 3. Storage Model

All in Postgres, `product` schema; no file storage or cache (platform §3). Column detail is in the overview's *Data Model*. Shared core (`core.APPUSER`, RBAC, `AUDIT_LOG`, `SYSTEM_CONFIG`) reused, never duplicated (platform §4).

| Data | Where | Notes |
|---|---|---|
| Offerings (`product.product_offering`) | Postgres | One row per offering; `version` is an **in-place metadata counter** bumped on any change — no versioned offering rows. `last_edited_by` FK → `core.APPUSER`. `lifecycle_status`: `DRAFT / ACTIVE / RETIRED`; only ACTIVE selectable for billing by later modules. `is_bundle` display-only (no `bundle_link` table). |
| Specifications (`product.product_specifications`) | Postgres | FK → offering. Characteristics (e.g. SST/SD identifiers) in `product_spec_characteristics` **JSONB**. |
| Prices (`product.product_offering_price`) | Postgres | **Immutable rows** — a change inserts a new row and bumps the offering `version`. `start_date_time` = billing effectivity; `created_at` = insert time (differs when future-dated); `end_date_time` **derived** from successor's start, never stored. `amount` nullable when `pricing_model = tiered`; tiers in `pricing_characteristics` JSONB. Constraint: UNIQUE (`product_offering_id`, `price_type`, `start_date_time`) — with derived ends, windows never overlap by construction (supersession: a new price truncates its predecessor); unique starts keep the derivation well-defined (revised 2026-07-04; backdating caveat in Inv. #2). |
| IDs | Postgres sequences | Prefix + zero-padded sequence: `PRDOFR` (offering), `PRDSMD` (spec), `PRDOFP` (price); one sequence per table. |
| Price history | Price rows themselves | Historical bill-run basis reproducible from immutable rows. **Audit log is forensics, never a rating source.** |
| Tier storage | JSONB (v1) | May migrate to a child table if the rating engine later needs SQL-queryable tiers — deferred, not decided. |

---

## 4. Authentication & Access Model

Auth mechanics unchanged (platform §5: Better-Auth sessions, live per-request permission resolution, 3-layer defense in depth). Module specifics:

- **Single `products` permission**, page-level, code-seeded via migration. READ gates the entire page **including prices** — no pricing-visibility split in v1. EDIT/DELETE seeded now, unused until CRUD.
- Page guard: `requirePermission('products', 'READ')` at `/products/product-offering`. No grant → `/no-access` (deny by default).
- Nav visibility follows the platform convention: items render regardless of permission; the guard enforces.

### Permission matrix additions

| Page (route) | Access | Required permission : level |
|---|---|---|
| `/products/product-offering` (list + detail + specs + prices) | Authenticated | `products` : **READ** |
| — create / edit offering, prices, specs, lifecycle transitions *(CRUD fast-follow)* | Authenticated | `products` : **EDIT** (seeded, unused in v1) |
| — delete *(CRUD fast-follow)* | Authenticated | `products` : **DELETE** (seeded, unused in v1) |

---

## 5. Background Tasks & AI

**None.** No AI/ML components (platform §6 stands). No module jobs: v1 is read-only, price effectivity is resolved at query time from `start_date_time` (per-request computation, not a job). **No new audit events** — reads are not audited; CRUD-phase mutations will add create/update/lifecycle events.

---

## 6. Module Invariants

Platform Invariants (`architecture.md` §7) all apply. Additional rules this module must never violate; each is testable and CI-enforceable:

1. **Price rows are immutable.** No code path UPDATEs or DELETEs a `product_offering_price` row. A price change INSERTs a successor row and bumps the offering's `version` in the same transaction.
2. **No overlapping effectivity.** Effectivity windows are derived `[start_date_time, successor start)`; two prices of the same `price_type` on one offering must never share a `start_date_time` — enforced by a DB UNIQUE constraint on (`product_offering_id`, `price_type`, `start_date_time`), not only app logic; violating seeds/inserts fail. *(Revised 2026-07-04: the btree_gist exclusion constraint was removed — with no stored end (Inv. #3), a range-exclusion constraint cannot reference the successor row. Unique starts keep the derivation well-defined; derived windows never overlap because a new price supersedes — truncates — its predecessor from its start instant. A start inside an existing window is therefore legitimate. Known caveat: a **backdated** start rewrites derived history, which touches the reproducible-billing-basis goal; the DB cannot prevent it, so the CRUD fast-follow must restrict backdated starts as a service rule. No v1 exposure — writes are seeds/SQL only.)*
3. **`end_date_time` is never stored.** A price's end is derived from its successor's `start_date_time`. No `end_date_time` or `last_update` column exists on the price table.
4. **JSONB is schema-guarded.** Every write of `pricing_characteristics` is validated by the Zod schema for its `pricing_model`; tiered tiers must be contiguous and non-overlapping. No unvalidated JSONB reaches the DB.
5. **`amount` and tiers are mutually exclusive.** `pricing_model = flat` ⇒ `amount` NOT NULL; `pricing_model = tiered` ⇒ `amount` NULL and tiers present in JSONB.
6. **Only ACTIVE offerings are billable.** Later modules (Customer, Billing Service, Bill Run) may reference only `lifecycle_status = ACTIVE` offerings for billing selection.
7. **The audit log is never a rating or pricing source.** Historical billing basis is reconstructed exclusively from immutable price rows + `start_date_time`.
8. **`version` is a metadata counter only.** It bumps in place on any offering change; no versioned offering rows, no version-aware queries.
9. **Product tables live in the `product` schema** and reference the shared core by FK (`last_edited_by` → `core.APPUSER`). The module creates no user, role, permission, session, config, or audit tables (platform Inv. #10 restated for emphasis).
10. **READ gates everything on the page.** Prices are never visible to a principal lacking `products : READ`; no partial rendering of specs/prices under a weaker check.
11. **v1 writes only via seeds/migrations.** No production code path mutates product tables until the CRUD fast-follow ships behind `products : EDIT`/`DELETE`.
12. **The route-group rename changes no URL.** `(admin)` → `(app)` must leave every existing Administration URL and the authz matrix results byte-identical; CI proves existing pages pass unchanged.
