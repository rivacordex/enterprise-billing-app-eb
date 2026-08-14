# Product Management — Architecture (Module)

This document builds on `context/architecture.md`, which owns the platform-wide design — stack, folder ownership, multi-module database design, the auth/authorization platform, and platform invariants — and records **only what the Product Management module adds or changes**. Anything not stated here is inherited unchanged. The product spec (user flows, data model, features) for the whole module — the catalog and the Ordering & Inventory update alike — is in `prodmgmt-project-overview.md`.

**Status:** SHIPPED — read-only catalog (units pm01–pm09, decisions agreed 2026-07-03), the CRUD fast-follow (units pm10–pm24, decisions agreed 2026-07-20), and the **Product Ordering & Inventory update** (units pm25–pm34, decisions locked 2026-07-23/31) are all implemented and ship-gate-verified. Its additions are still marked *(Ordering update)* throughout this document to distinguish them from the original catalog. Changes to *Module Invariants* require a documented design review.

**Scope:** The module has four shipped pages — **View Product** (`/products/product-offering`), a read-only catalog viewer; **Manage Products** (`/products/manage-products`), the full create/edit/branch/activate/retire surface; **Orders** (`/products/orders`), manual intake of billing-only offers with a manager-approval path for negotiated prices; and **Subscriptions** (`/products/subscriptions`), the product inventory instances with suspend/resume/terminate lifecycle. View Product and Manage Products share the three `product` schema tables and the `products` permission; Orders and Subscriptions add two new schemas (`ordering`, `inventory`) and two new permissions (`product_orders`, `product_inventory`), built on top of the accounts module's `billing.financial_account` / `billing.billing_account` / `billing.bill_cycle` tables, which landed first as this update's hard dependency.

---

## 1. Technology Stack — Deltas Only

The stack is inherited wholesale from `architecture.md` §1 (Next.js ≥ 15 App Router + RSC, Server Actions over `services/`, Azure PostgreSQL via Drizzle, Better-Auth, Container Apps, Azure DevOps, no cache/CDN, no rate limiting). This module introduces **no new stack components**. Module-specific usage notes:

| Layer | Technology (inherited) | This module's usage / delta |
|---|---|---|
| Frontend | Next.js App Router, RSC | All list state (search, filter, sort, page, row selection) on View Product lives in **URL searchParams** rendered by RSC — same pattern as Administration pages. Deep-link: `?offering=PRDOFR000001`. Manage Products is a thin RSC orchestrator with dialogs/forms as `'use client'` interaction leaves. No client-side state store for list state. *(Ordering update)* The New Order form is the app's first **multi-step wizard** (3 steps — customer → BAN → offer/price); step state is client-held UX only, never trusted — the submit re-validates everything server-side. |
| APIs & Backend | Server Actions + `services/` | `actions/product/**` exists — one file per mutation, following the platform's standard Server-Action shape (`requirePermission` → `safeParse` → delegate to `services/product` → `revalidatePath`). Reads flow RSC page → `services/product` → repositories. **No `app/api/product*` route, ever** — permanently forbidden regardless of phase. *(Ordering update)* New actions in `actions/ordering/**` and `actions/inventory/**`: create/approve/reject order, suspend/resume/terminate, edit instance characteristics. Same shape; no Route Handlers. |
| Database | PostgreSQL ≥ 16, Drizzle | **`product` schema** (platform §4 namespacing) with 3 tables. Uses **JSONB** columns (`product_spec_characteristics`, `pricing_characteristics`) — guarded by per-`pricing_model` Zod schemas, not free-form. `product_offering.family_offering_id` (nullable, self-referencing FK + index) links version history. *(Ordering update)* Two new schemas, **`ordering`** and **`inventory`** (5 tables, split on TMF622/TMF637 component lines) — the first module delivering two schemas, and the first transaction spanning three existing modules' tables (`customer`, `billing`, `product`) plus both new schemas. Locking reuses catalog pm16 patterns (`FOR UPDATE`, advisory locks) — no new primitives. |
| Auth & Permissions | Better-Auth + core RBAC | One code-seeded permission: `products` (READ/EDIT/DELETE). No auth mechanics change. *(Ordering update)* Two more code-seeded permissions, `product_orders` and `product_inventory`, plus the module's first **role-conditioned check**: order approval requires MANAGER role in addition to permission level (§4). |
| Validation | Zod in `validation/` | Per-`pricing_model` discriminated schemas (tiered requires contiguous, non-overlapping `[{from,to,rate}]` bounds) plus create/update-offering, create/update-specification, insert-price (with backdating check), and activate/retire schemas. *(Ordering update)* New `validation/ordering/**` and `validation/inventory/**`: order submission (characteristics `Record<string,string>`, override rows), review reason, lifecycle actions (effective date + reason, 3-day backdating check). Override price-type validity (`exists ∧ pricing_model = flat`) is service-checked — it needs DB state, not just shape. |
| Everything else | — | Unchanged: hosting, CI/CD, monitoring, backup/recovery, no cache, no RLS. |

---

## 2. System Boundaries — Folder Ownership Deltas

Dependency rule unchanged (UI → actions/routes → services → repositories → DB; inner layers never import outward). Platform-level changes this module delivered, plus its own subfolders:

| Path | Owns | Notes |
|---|---|---|
| `app/(app)/**` | Route group hosting all authenticated modules as plain subfolders (`administration/`, `products/`, later `customers/`, `bill-runs/`). Originally a rename from `(admin)` (Decision #10, pm01). | URL-invisible; new route groups only when chrome genuinely differs (cf. `(auth)`). |
| `app/(app)/products/product-offering/` | View Product: the four-section read-only page (offerings table, detail, specs, prices). Declares `products : READ` guard. Thin orchestrator composing `components/products/`. | No DB queries, no raw SQL, no heavy markup (platform §2). Nav label and page `H1` read "View Product"; route, components, and data logic otherwise untouched since v1. |
| `app/(app)/products/manage-products/` | Manage Products: the CRUD page — family-grouped offering list, row actions, create/edit/activate/retire/discard dialogs. Declares `products : EDIT` guard (retire/discard actions additionally re-check `DELETE`). | Structurally independent of `product-offering/` — imports no components from it, and vice versa (guardrail-enforced). |
| `components/admin-nav.tsx` | `NAV_SECTIONS` (caption + items per section). "Products" section, peer of "Administration", with two items: "View Product" (lucide `Package`) and "Manage Products" (lucide `PackagePlus`). | Collapsed-rail and active-state behavior unchanged. Nav renders regardless of permission; the page guard enforces access (platform convention). |
| `components/products/**` | Read-only, view-side components (`OfferingTable`, `OfferingDetail`, `SpecificationsPanel`, `PricesPanel`, `LifecycleBadge`, `PriceTypeBadge`) used by View Product. | A guardrail test asserts these import nothing from `components/products/manage/` or any write-path module. |
| `components/products/manage/**` | Write-capable UI: offering/spec/price forms, activate/retire/discard dialogs (`ManageOfferingTable`, `OfferingForm`, `SpecificationForm`, `SpecificationsDialog`, `PriceForm`, `RetireOfferingDialog`, `CreateOfferingDialog`, `AddPriceDialog`, `ActivateOfferingDialog`). | Deliberately separate from `components/products/*`. |
| `actions/product/**` | One Server Action file per mutation (`create-offering`, `update-offering`, `create-specification`, `update-specification`, `delete-specification`, `insert-price`, `activate-offering`, `retire-offering`). | No DB access in this layer — same convention as `actions/roles/**`. |
| `services/product/**` | Read use cases (`list-offerings.ts`, `get-offering-detail.ts`) and write use cases (`create-offering.ts`, `update-offering.ts`, `add-specification.ts`, `update-specification.ts`, `delete-specification.ts`, `insert-price.ts`, `activate-offering.ts`, `retire-offering.ts`) plus the shared `branchOfferingAsDraft` primitive. Framework-agnostic; no `next/*` imports. | |
| `db/**` (product scope) | Drizzle schema for the `product` schema (3 tables + `family_offering_id` lineage column + index), migrations, seeds (incl. `products` PERMISSIONS row), sequences, constraints, repositories. Repositories carry both finder and write methods; the price repository gains exactly one write, `insertPrice` — never `update*`/`delete*` (Inv. #1). | Only place SQL lives. |
| `validation/product/**` | Zod schemas for list params, `pricing_characteristics` per `pricing_model`, create/update-offering, create/update-specification, insert-price (backdating), activate/retire (optional `reason`). | Parsed before any service call. |
| `tests/**` | Repo/service unit tests, integration tests for every write path and versioning invariant, authz-matrix entries for both `/products/product-offering` and `/products/manage-products`, and the module guardrail suite (`product-module-boundaries.test.ts`). | Both pages must appear in the authz matrix (platform §5). |

*(Ordering update — additions to this table:)*

| Path | Owns | Notes |
|---|---|---|
| `app/(app)/products/orders/` | Orders list + three-step New Order wizard + manager review view. Guard: `product_orders : READ`; EDIT re-checked per action. | Thin orchestrator; no DB queries. |
| `app/(app)/products/subscriptions/` | Subscriptions list, expandable status history, lifecycle + edit-characteristics dialogs. Guard: `product_inventory : READ` / `EDIT`. | Same conventions. |
| `components/products/ordering/**` | Wizard steps, order table, review panel, characteristics editor, override price inputs. | Presentational; permission map passed in, never resolved here. |
| `components/admin-nav.tsx` | "Products" `NAV_SECTIONS` entry gains two items: "Orders", "Subscriptions" (data-only diff, pm17 pattern). | Nav renders regardless of permission; guards enforce. |
| `actions/ordering/**`, `actions/inventory/**` | Mutation entry points (create/approve/reject order; suspend/resume/terminate; edit characteristics). Guard → `safeParse` → service → `revalidatePath`. | **New folders** — deliberately not `actions/product/`, so its `EXPECTED_PRODUCT_ACTION_FILES` guardrail stays catalog-only. |
| `services/ordering/**`, `services/inventory/**` | Order create/approve/reject use cases; subscription lifecycle + list/detail use cases. Framework-agnostic. | **Cross-module rule (revised 2026-08-09 to match the delivered ac04 precedent — `onboard-customer-accounts.ts` imports `partyRoleRepository` directly):** display/form reads call `services/customer` / `services/product` / `services/accounts`; **in-transaction precondition re-checks use the other modules' repositories' locked (`FOR UPDATE`) finders directly** — a service of another module cannot participate in this module's transaction. No cross-module SQL joins except the list-view joins declared in this module's own repositories. |
| `db/schema/ordering.ts`, `db/schema/inventory.ts` (+ repositories, migrations, seeds) | Drizzle schemas, sequences, constraints, permission seed rows, repositories for the 5 new tables. | `inventory_status_history` and `order_item_price_override` repositories export **no update/delete, permanently**. |
| `validation/ordering/**`, `validation/inventory/**` | Zod schemas per §1. | Parsed before any service call. |
| `tests/**` (ordering scope) | Authz-matrix entries for both new pages; guardrail tests for repository surfaces and the two new action folders; concurrency tests (approve-vs-reject race, dual lifecycle actions). | Both pages in the matrix before ship. |

---

## 3. Storage Model

All in Postgres, `product` schema; no file storage or cache (platform §3). Column detail is in the overview's *Data Model*. Shared core (`core.APPUSER`, RBAC, `AUDIT_LOG`, `SYSTEM_CONFIG`) reused, never duplicated (platform §4).

| Data | Where | Notes |
|---|---|---|
| Offerings (`product.product_offering`) | Postgres | Multiple rows per product are the norm — one per version. `product_offering.family_offering_id` (nullable, self-referencing FK, indexed) links versions of the same product: `NULL` means the row **is** the family's root; a non-null value points directly at the root's id, always one hop, so "all versions of this product" is `WHERE product_offering_id = :rootId OR family_offering_id = :rootId`. `version` is **the row's sequence number within its family** — root is `1`, first branch is `2`, and so on — computed as `MAX(version)` across the resolved family + 1, assigned once at insert, never changed afterward (including for an in-place edit to an already-`DRAFT` row, which updates content and `last_modified` but not `version`). `last_edited_by` FK → `core.APPUSER`. `lifecycle_status`: `DRAFT / ACTIVE / RETIRED`; only ACTIVE selectable for billing by later modules; **at most one row per family may be `ACTIVE` at a time**. `is_bundle` is display-only (no `bundle_link` table), never user-settable, and is copied through unchanged when a row is cloned (branched). |
| Specifications (`product.product_specifications`) | Postgres | FK → offering. Characteristics (e.g. SST/SD identifiers) in `product_spec_characteristics` **JSONB**. Unchanged in shape by the versioning model — a write against an `ACTIVE` offering is redirected by the *service layer* (branch-first) onto a freshly cloned `DRAFT` row's children, never by a change to this table. |
| Prices (`product.product_offering_price`) | Postgres | **Immutable, insert-only rows** — a change on a `DRAFT` inserts a new row against that same row (no `version` bump; `version` is not a per-change counter, see above). A change targeting an `ACTIVE` offering instead inserts against a brand-new, branched `DRAFT` row with its own freshly assigned `version`; the original `ACTIVE` row and its prices are untouched. `start_date_time` = billing effectivity; `created_at` = insert time (differs when future-dated); `end_date_time` **derived** from successor's start, never stored. `amount` nullable when `pricing_model = tiered`; tiers in `pricing_characteristics` JSONB. Constraint: UNIQUE (`product_offering_id`, `price_type`, `start_date_time`) — with derived ends, windows never overlap by construction (supersession: a new price truncates its predecessor); unique starts keep the derivation well-defined. Backdating: a price's `start_date_time` may be up to 3 days in the past (non-blocking warning shown), rejected beyond that — enforced in the service layer (`insert-price.ts`), not the DB. |
| IDs | Postgres sequences | Prefix + zero-padded sequence: `PRDOFR` (offering), `PRDSMD` (spec), `PRDOFP` (price); one sequence per table. |
| Price history | Price rows themselves | Historical bill-run basis reproducible from immutable rows. **Audit log is forensics, never a rating source.** |
| Tier storage | JSONB | May migrate to a child table if the rating engine later needs SQL-queryable tiers — deferred, not decided. |

**Why a self-referencing column rather than matching on `name` for version linkage:** names change, and two unrelated offerings can legitimately share one. A flat, one-hop self-reference costs one column and one index and stays correct regardless of renames. `family_offering_id` is the only schema addition beyond v1's original 3 tables; `product_specifications` and `product_offering_price` are otherwise unchanged in shape.

### Ordering & Inventory storage *(Ordering update)*

New schemas `ordering` and `inventory`; the `product` schema tables above are **not modified**. Column detail and sample data are in `_updatemodule-product-ordering-inventory-plan.md` §Data & storage.

| Data | Where | Notes |
|---|---|---|
| Order header | `ordering.product_order` (`PRDORD…`) | Full TMF622 status enum seeded; phase writes `ACKNOWLEDGED / PENDING / COMPLETED / REJECTED / FAILED`. `reviewed_by`/`reviewed_at` (Q18) set on approve **or** reject; CHECK `reviewed_by <> submitted_by`. |
| Order item | `ordering.product_order_item` (`PRDORI…`) | Write-once. FKs the **exact `product_offering` version row** ordered (Q5 grandfathering) — no price/spec snapshot columns; the immutable version FK *is* the snapshot. `ordered_characteristics` JSONB (Zod-guarded). |
| Negotiated price | `ordering.order_item_price_override` (`PRDOPO…`) | **Insert-only.** UNIQUE (item, price_type); flat price types only; currency = BAN currency. Rating contract: override row if present, else the catalog price row effective on the rating date. |
| Subscription | `inventory.product_inventory` (`PRDINV…`) | 1:1 with order item (UNIQUE FK). Pins the offering version; denormalizes `customer_party_role_id` + `billing_account_id` for the bill-run read path. `instance_characteristics` JSONB — the only editable billing-adjacent field (audited; never a rating input). TMF637 status enum seeded; phase uses `ACTIVE / SUSPENDED / TERMINATED`. |
| Status history | `inventory.inventory_status_history` (`PRDIVE…`) | **Append-only, gap-free** transition log; suspension windows derived from consecutive rows; `effective_date` ≠ `created_at` when backdated (≤3 days, Q19). |
| Cross-schema FKs | → `customer.party_role`, `billing.billing_account`, `product.product_offering`, `core.APPUSER` | Platform §4 pattern; the `billing.*` FKs are the accounts-module dependency (header fallback). **No cycle/frequency column anywhere in these schemas** — cycle lives on the BAN (Q6, `billing.bill_cycle` per account-plan Q13). |

---

## 4. Authentication & Access Model

Auth mechanics unchanged (platform §5: Better-Auth sessions, live per-request permission resolution, 3-layer defense in depth). Module specifics:

- **Single `products` permission**, page-level, code-seeded via migration. READ gates the View Product page **including prices** — no pricing-visibility split. EDIT gates offering/specification create-edit, branching, and price add on Manage Products; DELETE gates retirement and discard.
- Page guards: `requirePermission('products', 'READ')` at `/products/product-offering`; `requirePermission('products', 'EDIT')` at `/products/manage-products` (retire/discard actions additionally re-check `DELETE`). No grant → `/no-access` (deny by default).
- Nav visibility follows the platform convention: items render regardless of permission; the guard enforces.

*(Ordering update)* Two additional code-seeded permissions with **no overlap** against `products` — a catalog grant confers no ordering access and vice versa: `product_orders` (orders list, order creation, approval) and `product_inventory` (subscriptions list, lifecycle, characteristics). **Approval is permission + role + identity:** approve/reject requires `product_orders : EDIT` **and** the MANAGER role **and** reviewer ≠ submitter — enforced in the service, backstopped by the DB CHECK. This is the module's first role-conditioned authorization (precedent: accounts-plan Q7); the role is an *additional* condition, not a new permission level. Approval also re-runs the **entire submission validation set** under row locks at approval time — a `PENDING` order approved days later must not instantiate against stale state.

### Permission matrix

| Page (route) | Access | Required permission : level |
|---|---|---|
| `/products/product-offering` (View Product — list + detail + specs + prices) | Authenticated | `products` : **READ** |
| `/products/manage-products` (Manage Products — create / edit / branch / activate) | Authenticated | `products` : **EDIT** |
| `/products/manage-products` — retire / discard | Authenticated | `products` : **DELETE** |
| `/products/orders` (list + detail) *(Ordering update)* | Authenticated | `product_orders` : **READ** |
| — create order (wizard submit) *(Ordering update)* | Authenticated | `product_orders` : **EDIT** |
| — approve / reject a `PENDING` order *(Ordering update)* | Authenticated | `product_orders` : **EDIT** + **MANAGER role** + reviewer ≠ submitter |
| `/products/subscriptions` (list + history) *(Ordering update)* | Authenticated | `product_inventory` : **READ** |
| — suspend / resume / terminate / edit characteristics *(Ordering update)* | Authenticated | `product_inventory` : **EDIT** |

---

## 5. Background Tasks & AI

**None.** No AI/ML components (platform §6 stands). No module jobs: price effectivity is resolved at query time from `start_date_time` (per-request computation, not a job).

**Audit events.** View Product reads are never audited. Manage Products mutations write one audit event per action, inside the same transaction as the data change: `PRODUCT_OFFERING_CREATED`, `PRODUCT_OFFERING_UPDATED`, `PRODUCT_OFFERING_BRANCHED`, `PRODUCT_OFFERING_ACTIVATED`, `PRODUCT_OFFERING_SUPERSEDED`, `PRODUCT_OFFERING_RETIRED`, `PRODUCT_OFFERING_DISCARDED`, `PRODUCT_SPECIFICATION_CREATED`, `PRODUCT_SPECIFICATION_UPDATED`, `PRODUCT_SPECIFICATION_DELETED`, `PRODUCT_PRICE_ADDED`. An optional free-text reason on activation/retirement/discard is carried in the audit event's `afterData` payload (`transitionReason`), not a new `product_offering` column.

*(Ordering update)* Subscription instantiation is **not a job** — it runs inside the order-completion (or approval) request transaction; no schedulers or queues are added (the first scheduled job in this product line would be the future bill run, out of scope — see `_newmodule-billing-billrun-plan.md`). New audit events, written transactionally like the above: `PRODUCT_ORDER_CREATED / _PENDING_APPROVAL / _APPROVED / _REJECTED / _COMPLETED / _FAILED`, `PRODUCT_INVENTORY_CREATED / _CHARACTERISTICS_UPDATED / _SUSPENDED / _RESUMED / _TERMINATED`.

---

## 6. Module Invariants

Platform Invariants (`architecture.md` §7) all apply. Additional rules this module must never violate; each is testable and CI-enforceable:

1. **Price rows are immutable and insert-only.** No code path UPDATEs or DELETEs a `product_offering_price` row, in any phase. The price repository exports no `update*`/`delete*` — ever; `insertPrice` is its only write.
2. **No overlapping effectivity.** Effectivity windows are derived `[start_date_time, successor start)`; two prices of the same `price_type` on one offering must never share a `start_date_time` — enforced by a DB UNIQUE constraint on (`product_offering_id`, `price_type`, `start_date_time`), not only app logic; violating seeds/inserts fail. Derived windows never overlap because a new price supersedes — truncates — its predecessor from its start instant; a start inside an existing window is legitimate by construction. Backdating: a new price's `start_date_time` may be up to 3 days in the past (accepted with a non-blocking UI warning); beyond that, the write is rejected (`BACKDATED_START_TOO_FAR`) — a service-layer check (`insert-price.ts`), not a DB constraint, since the DB has no way to express "within tolerance of the current instant at write time."
3. **`end_date_time` is never stored.** A price's end is derived from its successor's `start_date_time`. No `end_date_time` or `last_update` column exists on the price table.
4. **JSONB is schema-guarded.** Every write of `pricing_characteristics` or `product_spec_characteristics` — including seeds — is validated by the Zod schema for its `pricing_model`/spec shape first; tiered tiers must be contiguous and non-overlapping. No unvalidated JSONB reaches the DB.
5. **`amount` and tiers are mutually exclusive.** `pricing_model = flat` ⇒ `amount` NOT NULL; `pricing_model = tiered` ⇒ `amount` NULL and tiers present in JSONB. Enforced by a DB CHECK constraint; Zod mirrors it.
6. **Only ACTIVE offerings are billable, and at most one per family.** Later modules (Customer, Billing Service, Bill Run) may reference only `lifecycle_status = ACTIVE` offerings for billing selection. At most one row per version family may be `ACTIVE` at any time; activating a version automatically retires whichever other version in its family was previously active, in the same transaction.
7. **The audit log is never a rating or pricing source.** Historical billing basis is reconstructed exclusively from immutable price rows + `start_date_time`.
8. **`version` is a row's sequence number within its version family**, assigned once at insert and never changed afterward. Versioned offering rows are the norm, not an exception — `family_offering_id` (§3) makes every query that needs "all versions of this product" or "the current active version" explicitly version-aware (e.g. `findActiveInFamily`).
9. **Product tables live in the `product` schema** and reference the shared core by FK (`last_edited_by` → `core.APPUSER`). The module creates no user, role, permission, session, config, or audit tables (platform Inv. #10 restated for emphasis) — the `family_offering_id` column is an addition to an existing table, not a new one.
10. **READ gates everything on the View Product page.** Prices are never visible to a principal lacking `products : READ`; no partial rendering of specs/prices under a weaker check.
11. **Writes flow exclusively through the mutation stack.** Every production code path that mutates a product table does so through `actions/product/**` → `services/product/*-write.service.ts` → repositories, gated by `products : EDIT`/`DELETE`. No other entry point exists.
12. **The route-group rename changed no URL.** `(admin)` → `(app)` (pm01) left every existing Administration URL and the authz matrix results byte-identical; CI proves existing pages pass unchanged.
13. **Single-active-per-family is enforced transactionally, not by a single DB constraint.** A plain unique index on `family_offering_id` can't cleanly cover "the root itself is `ACTIVE`, one of its branches also tries to activate," because the root's `family_offering_id` is `NULL` and NULLs don't collide in a unique index. `activateOffering` row-locks the family (`findActiveInFamily(...).for("update")`) and re-checks "is there currently another `ACTIVE` row in this family?" **inside** the transaction before flipping status — the same defense-in-depth pattern `roles-write.service.ts`'s `deleteRole` uses to close a race window. This is a deliberate, documented trade-off, not an oversight.
14. **Editing an `ACTIVE` offering never mutates it in place.** There is no in-place write path for an `ACTIVE` offering's own fields, its specifications, or its prices. Any such edit first clones the offering plus all of its specifications and all of its prices into a new `DRAFT` row (`branchOfferingAsDraft`), then applies the edit to that clone. The original `ACTIVE` row and everything attached to it are provably untouched — the same "immutable, insert instead of update" discipline established for prices alone (Inv. #1), extended to the offering and its specifications whenever the source is live.

*Invariants 15–22 are introduced by the Ordering & Inventory update; #16 and #18 strengthen platform Inv. #18 for this module's tables. Their CI-enforceable test homes are code-standards §9 guardrails 15–22 (pm34 ship gate).*

15. **Order items and subscriptions are write-once at the billing-relevant core.** `product_offering_id`, `quantity`, `start_date`, `ordered_characteristics`, and every override row never change after creation; corrections are terminate + re-order. Sole exception: `inventory.instance_characteristics` (audited, descriptive, never rated).
16. **Every price a customer pays is either an immutable catalog price row or an insert-only, manager-approved override row.** No third source; no editable price column exists anywhere. Rating resolves override-else-catalog per price type. An order with an override reaches `COMPLETED` only through the approval path.
17. **A catalog version referenced by any subscription is a rating source regardless of `lifecycle_status`.** Grandfathering (Q5) makes `RETIRED` rows live billing data; no code path may assume `ACTIVE`-only when reading a pinned version. (Extends Inv. #6: "only ACTIVE offerings are billable" governs *selection at order time*; once pinned, the referenced version remains rateable for that subscription's lifetime.)
18. **`inventory_status_history` is append-only and gap-free.** Every status an instance ever held appears as a transition row; the `status` column is always derivable from the latest row; the repository permanently exports no update/delete.
19. **One transaction per user action, TOCTOU-checked.** Order completion, approval, suspend, resume, and terminate each commit all their rows atomically, with every precondition re-read under `FOR UPDATE` inside the transaction. Approval re-runs the full submission validation, not a status flip.
20. **Cycle lives on the BAN.** No cycle, frequency, or bill-run column may be added to `ordering.*` or `inventory.*` tables (Q6; the catalog is `billing.bill_cycle`, account-plan Q13).
21. **All billing dates are inclusive-billed.** `start_date` = first billed day; `end_date` = last billed day; suspension `effective_date` = first non-billed day; resume-day treatment is reserved to the bill-run phase (Q17/Q20). Backdating any of them beyond 3 days is rejected (Q19).
22. **Reviewer ≠ submitter, enforced server-side.** The approval service rejects self-review independently of the UI; the DB CHECK on `reviewed_by` backstops it.
