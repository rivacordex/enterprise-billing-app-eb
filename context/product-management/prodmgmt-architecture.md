# Product Management — Architecture (Module)

This document builds on `context/architecture.md`, which owns the platform-wide design — stack, folder ownership, multi-module database design, the auth/authorization platform, and platform invariants — and records **only what the Product Management module adds or changes**. Anything not stated here is inherited unchanged. The product spec (user flows, data model, features) for the whole module — the catalog, the Ordering & Inventory update, and the Manage Products rebuild alike — is in `prodmgmt-project-overview.md` and `prodmgmt-update-overview.md`.

**Status:** SHIPPED — read-only catalog (units pm01–pm09, decisions agreed 2026-07-03), the CRUD fast-follow (units pm10–pm24, decisions agreed 2026-07-20), and the **Product Ordering & Inventory update** (units pm25–pm34, decisions locked 2026-07-23/31) are implemented and ship-gate-verified. **PLANNED — the Manage Products rebuild & catalog lifecycle update** (decisions D1–D13 locked 2026-09-19, `_updatemodule-product-manage-page-refactor-plan.md`). Shipped additions are marked *(Ordering update)*; planned ones are marked *(Manage rebuild)*. Changes to *Module Invariants* require a documented design review — **five such amendments are pending approval for the Manage rebuild** (Inv. #1, #6, #13, #14, #17 below, plus platform Inv. #18).

**Scope:** Four shipped pages — **View Product** (`/products/product-offering`), **Manage Products** (`/products/manage-products`), **Orders** (`/products/orders`), **Subscriptions** (`/products/subscriptions`). The Manage rebuild changes Manage Products' internals and the `product` schema only; it adds no page, no route, no permission and no table.

---

## 1. Technology Stack — Deltas Only

The stack is inherited wholesale from `architecture.md` §1 (Next.js ≥ 15 App Router + RSC, Server Actions over `services/`, Azure PostgreSQL 17 via Drizzle, Better-Auth, Container Apps, Azure DevOps, no cache/CDN, no rate limiting). This module introduces **no new stack components in any phase.** Module-specific usage notes:

| Layer | Technology (inherited) | This module's usage / delta |
|---|---|---|
| Frontend | Next.js App Router, RSC | View Product holds all list state (search, filter, sort, page, selection) in **URL searchParams**; deep-link `?offering=PRDOFR000001`. *(Ordering update)* The New Order form is the app's first multi-step wizard; step state is client-held UX only. *(Manage rebuild)* Manage Products moves from a page-local family tree to the same URL-state convention — `?family=…&version=…` — with the families list, version bar, specifications panel and pricing panel each fetched server-side. Editing is **inline within the panels**; dialogs remain only for the five consequential confirmations (submit for testing, activate, stop selling, retire, discard). |
| APIs & Backend | Server Actions + `services/` | `actions/product/**`, one file per mutation, standard shape (`requirePermission` → `safeParse` → service → `revalidatePath`). **No `app/api/product*` route, ever.** *(Manage rebuild)* Five new actions: submit-for-testing, return-to-draft, obsolete-offering, retire-offering (re-purposed), delete-offering; plus update-price and delete-price. |
| Database | PostgreSQL 17, Drizzle | `product` schema, 3 tables, JSONB guarded per `pricing_model`. *(Manage rebuild)* No new table. `lifecycle_status` gains `TESTING` and `OBSOLETE`; the price table gains per-price-type NOT NULL-equivalent CHECKs and a closed unit list; two expression unique indexes and one status-guard trigger are added; the child-table FKs move to `ON DELETE cascade`. Migration mechanics in §3.4. |
| Auth & Permissions | Better-Auth + core RBAC | `products` (READ/EDIT/DELETE); *(Ordering update)* `product_orders`, `product_inventory`, plus the module's first role-conditioned check. *(Manage rebuild)* **No new permission and no new level semantics** — the new transitions are distributed across the existing EDIT/DELETE split (§4). |
| Validation | Zod in `validation/` | Per-`pricing_model` discriminated schemas; create/update offering and specification; insert-price with backdating. *(Manage rebuild)* `insert-price.schema.ts` gains per-`price_type` conditional requirements (charge period for `recurring`, unit of measure for `usage`, neither for `once`) and a closed unit enum; a new `update-price.schema.ts` shares them. |
| Everything else | — | Unchanged: hosting, CI/CD, monitoring, backup/recovery, no cache, no RLS, no jobs. |

---

## 2. System Boundaries — Folder Ownership Deltas

Dependency rule unchanged (UI → actions → services → repositories → DB; inner layers never import outward).

| Path | Owns | Notes |
|---|---|---|
| `app/(app)/products/product-offering/` | View Product: four-section read-only page. Guard `products : READ`. | Unchanged by the Manage rebuild. |
| `app/(app)/products/manage-products/` | Manage Products: the CRUD surface. Guard `products : EDIT`; DELETE re-checked per action. | *(Manage rebuild)* Becomes a thin orchestrator over a **server-paged family list** plus per-version panels. The page-local `fetchAllForStatus` / `fetchAllOfferingRows` / `fetchSpecificationsByOfferingId` / `groupIntoFamilies` helpers and the `MAX_COMBINED_ROWS` ceiling are **deleted**; grouping moves into the repository (§3.3). |
| `components/products/**` | Read-only, view-side components (`OfferingTable`, `OfferingDetail`, `SpecificationsPanel`, `PricesPanel`, `LifecycleBadge`, `PriceTypeBadge`). | *(Manage rebuild)* **Import direction is now one-directional, not mutual.** `components/products/manage/**` **may** import these read-only presentational components; `components/products/*` still imports nothing from `manage/` or any write path (guardrail 11 unchanged). The previous "and vice versa" wording is withdrawn — it would have forced a second copy of the price and specification rendering. |
| `components/products/manage/**` | Write-capable UI. | *(Manage rebuild)* Gains the families table, version bar, and the editable panel variants; loses the family-expand tree and the per-row action cluster (actions move into the selected version's header). |
| `actions/product/**` | One Server Action per mutation. | *(Manage rebuild)* `EXPECTED_PRODUCT_ACTION_FILES` grows by the seven files in §1; the guardrail asserting the exact set is updated with them. |
| `services/product/**` | Read and write use cases + the shared `branchOfferingAsDraft` primitive. | *(Manage rebuild)* Adds the transition services and the DRAFT-only price mutations; `retire-offering.ts` splits into `obsolete-offering.ts` (ACTIVE → OBSOLETE), `retire-offering.ts` (OBSOLETE → RETIRED, subscription-gated) and `delete-offering.ts` (hard delete). |
| `db/**` (product scope) | Drizzle schema, migrations, seeds, sequences, constraints, repositories. | *(Manage rebuild)* The price repository gains exactly two writes beyond `insertPrice`: `updatePrice` and `deletePrice`, both refusing a parent that is not DRAFT. A new `findFamilyPage` read model returns grouped, paged families. |
| `validation/product/**` | Zod schemas. | Parsed before any service call. |
| `tests/**` | Repo/service units, integration tests per write path, authz matrix, module guardrails. | *(Manage rebuild)* Guardrails 2, 8, 13 and 16 are re-scoped (§6); V1–V10 in the plan are the new suites. |

*(Ordering update — unchanged:)* `app/(app)/products/orders/`, `app/(app)/products/subscriptions/`, `components/products/ordering/**`, `components/products/inventory/**`, `actions/ordering/**`, `actions/inventory/**`, `services/ordering/**`, `services/inventory/**`, `db/schema/ordering.ts`, `db/schema/inventory.ts` and their repositories, migrations and seeds. The Manage rebuild touches none of them; its only reach into ordering/inventory is a **read** of `inventory.product_inventory` for the retirement gate (§3.6).

---

## 3. Storage Model

All in Postgres, `product` schema; no file storage, no cache (platform §3). Shared core reused, never duplicated.

### 3.1 Tables

| Data | Where | Notes |
|---|---|---|
| Offerings (`product.product_offering`) | Postgres | One row per version. `family_offering_id` (nullable, self-FK, indexed): `NULL` = this row is the family root; non-null points at the root, always one hop. `version` = sequence number within the family, assigned once at insert, never changed. `last_edited_by` FK → `core.APPUSER`. **`lifecycle_status` *(Manage rebuild)*: `DRAFT / TESTING / ACTIVE / OBSOLETE / RETIRED`** (was `DRAFT / ACTIVE / RETIRED`). At most one ACTIVE and at most one open (DRAFT or TESTING) row per family, now index-backed (§3.3). `is_bundle` stays display-only and never user-settable. |
| Specifications (`product.product_specifications`) | Postgres | FK → offering, **`ON DELETE cascade` *(Manage rebuild)*** (was `restrict`). Characteristics in `product_spec_characteristics` JSONB. Writable only while the parent is DRAFT, enforced by trigger (§3.5). |
| Prices (`product.product_offering_price`) | Postgres | FK → offering, **`ON DELETE cascade` *(Manage rebuild)***. `start_date_time` = billing effectivity; `created_at` = insert time; `end_date_time` **derived**, never stored. `amount` XOR tiers. Rows are **immutable once the parent leaves DRAFT** *(Manage rebuild — amended Inv. #1)*; while DRAFT they may be updated and deleted. Backdating tolerance (3 days) unchanged, still a service-layer check. |
| IDs | Postgres sequences | `PRDOFR` / `PRDSMD` / `PRDOFP`, one sequence per table, prefix + zero-padded. |
| Price history | The price rows themselves | Historical bill-run basis reproducible from the rows. **Audit log is forensics, never a rating source.** |
| Tier storage | JSONB | Child-table migration still deferred to the rating module. |

### 3.2 Price column completeness *(Manage rebuild)*

The app previously wrote `NULL` into four columns on every price it created; only seeds populated them. Two become conditionally required, because a downstream consumer reads them:

| Column | Rule | Consumer |
|---|---|---|
| `recurring_charge_period_length`, `recurring_charge_period_type` | Required when `price_type = 'recurring'`; must be `NULL` otherwise. Accepted combinations are **closed** (O1 resolved): `'months'` only, length in (1, 3, 12) — (1, `months`) → monthly, (3, `months`) → quarterly, (12, `months`) → annually. `'years'` is deliberately **not** accepted; months-only gives exactly one encoding per cycle. Enforced by `product_offering_price_period_value_check` (pm35 D4). | `bm29` maps the charge period onto `billing.bill_cycle` before multiplying by subscription quantity; a `NULL` period is unresolvable and fails the account `RECURRING_PRICE_NOT_FOUND`. |
| `unit_of_measure` | Required when `price_type = 'usage'`; must be `NULL` otherwise. Closed list, **case-sensitive, exact match**: `Mbps`, `GB`, `MB`, `EA`. DB CHECK + TS union. `Mbps` keeps that casing deliberately (`MBPS` is ambiguous between megabit and megabyte per second); `EA` means "each", a countable unit. | Nothing yet — rating v1 is `FLAT` and ignores quantity. The list exists so per-unit rating has a defined product-side vocabulary. See §7 for the cross-module mismatch this does **not** solve. |
| `policy` | Stays in the table, stays `NULL`, stays out of the form. | None; semantics undefined. |

### 3.3 Indexes and the family rules *(Manage rebuild)*

```sql
CREATE UNIQUE INDEX product_offering_one_open_per_family
  ON product.product_offering ((COALESCE(family_offering_id, product_offering_id)))
  WHERE lifecycle_status IN ('DRAFT','TESTING');

CREATE UNIQUE INDEX product_offering_one_active_per_family
  ON product.product_offering ((COALESCE(family_offering_id, product_offering_id)))
  WHERE lifecycle_status = 'ACTIVE';
```

**This corrects a documented claim.** Inv. #13 and code-standards §6.11 previously stated that a clean partial-unique-index equivalent was impossible because a family root carries `family_offering_id IS NULL` and NULLs do not collide. Expression-indexing `COALESCE(family_offering_id, product_offering_id)` removes the NULL entirely; it was tested against PostgreSQL 16.13 and rejected both a second open version and a second ACTIVE version, for a root row and for a branch. The existing advisory lock and in-transaction re-check in `activateOffering` **remain** — the indexes are a backstop against a bug or a direct SQL write, changing the failure mode from "two live versions" to "rejected write".

The unchanged UNIQUE (`product_offering_id`, `price_type`, `start_date_time`) keeps the derived-effectivity window well defined; several dated prices of one type may only be *created* while the version is DRAFT, so the schedule an ACTIVE version carries is fixed at activation.

### 3.4 Migration mechanics *(Manage rebuild)* — verified, do not re-derive

| Fact | Evidence | Consequence |
|---|---|---|
| The migrator applies **all pending migrations inside one transaction** | `drizzle-orm@0.45.2`, `pg-core/dialect.js` `migrate()` wraps its loop in `session.transaction(...)` | A migration cannot use an enum value that an earlier migration file added in the same run. |
| `ALTER TYPE … ADD VALUE` then using that value in the same transaction fails | Tested on PG 16.13: `ERROR: unsafe use of new value "OBSOLETE" of enum type …` | The add-value form is unusable here, whether split across files or not. |
| Create-new-type-and-swap **does** work in one transaction | Tested: `CREATE TYPE …_new; ALTER TABLE … ALTER COLUMN … TYPE …_new USING s::text::…_new; DROP TYPE …; ALTER TYPE …_new RENAME TO …` | This is the fallback if the fresh-install assumption is ever withdrawn. |
| An edited, already-applied migration is **silently skipped** on an existing database | The migrator compares `folderMillis > last_applied.created_at`; the `hash` column is written but never compared | Editing `0006` only reaches databases built from scratch — which is exactly the D11 assumption. |

**D11, this round only:** the product migrations are treated as not yet applied. `0006_product.sql`'s `CREATE TYPE` is edited in place to the five-value enum and its price-table DDL to carry the new CHECKs and cascade FKs. Consequences: every environment rebuilds its database (role passwords and the step-6 grant patch live in the volume and do not survive); `db/schema/product.ts` is kept in sync by hand with no `drizzle-kit generate` (the `0006` snapshot and `meta/_journal.json` stay unchanged, D2); guardrail 13 is re-baselined; `prodmgmt-ai-workflow-rules.md` §5.3 and `db/migrations/README.md` §4 record the one-round suspension of the never-edit-an-applied-migration rule. **No relabelling migration, backfill, or data-fix script exists in the result.** **Deploy precondition:** because the migrator silently skips an edited, already-applied migration (mechanics table above), deployment must first confirm every target database is (re)built from empty — a database that already recorded `0006` retains the old three-value enum and the missing CHECKs. A not-from-empty target is a blocked deploy, not a supported path; there is deliberately no forward migration or backfill for existing installations.

### 3.5 Status-guard trigger *(Manage rebuild)*

```
BEFORE INSERT OR UPDATE OR DELETE ON product.product_specifications
BEFORE INSERT OR UPDATE OR DELETE ON product.product_offering_price
  → reject unless the parent product_offering.lifecycle_status = 'DRAFT'
```

This follows the platform's own rule that a restricted lifecycle transition is enforced by a trigger rather than by application code (`architecture.md` §4). It is what allows Inv. #1 to be *relaxed* for DRAFT without weakening it: a direct SQL write against a released version's prices still fails. The delete branch must not block the §3.1 cascade when a `DRAFT` or `TESTING` parent is hard-deleted: it exempts the cascade path — the child delete fires while the parent row is itself being deleted. Parent-first cascade is the **only** supported hard-delete path; deleting children explicitly before the parent fails for a `TESTING` parent, since the trigger rejects a child delete whenever the parent is not `DRAFT` (plan verification item V6, which covers both the `DRAFT` and `TESTING` cases).

### 3.6 Retirement gate *(Manage rebuild)*

`OBSOLETE → RETIRED` is refused while any `inventory.product_inventory` row pinned to that version satisfies:

```sql
status <> 'TERMINATED' OR (end_date IS NULL OR end_date >= current_date)
```

A TERMINATED subscription with a future `end_date` is still billed to that date (inclusive-billed convention, Inv. #21), so it counts as live. This is a **cross-schema read** performed inside the retirement transaction via the inventory repository's locked finder, per the cross-module rule in code-standards §1.14 — not a join, not a call into `services/inventory`.

Retirement is a **label**: no row is deleted, so a rerun of an old period still resolves. Bill-run reruns additionally read the stored `customer_bill_line` price snapshot rather than re-resolving (bm29 D19).

### Ordering & Inventory storage *(Ordering update — unchanged)*

New schemas `ordering` and `inventory`; the `product` tables are not modified by that update. Order header (`ordering.product_order`), order item (`ordering.product_order_item`, write-once, FK to the **exact offering version** — the version FK *is* the price/spec snapshot), negotiated price (`ordering.order_item_price_override`, insert-only, flat types only), subscription (`inventory.product_inventory`, pins the version, denormalizes party + BAN), status history (`inventory.inventory_status_history`, append-only and gap-free). Cross-schema FKs → `customer.party_role`, `billing.billing_account`, `product.product_offering`, `core.APPUSER`. No cycle or frequency column anywhere in these schemas.

---

## 4. Authentication & Access Model

Auth mechanics unchanged (platform §5). Module specifics:

- **Single `products` permission**, page-level, code-seeded. READ gates View Product including prices — no pricing-visibility split. EDIT gates content authoring and release; DELETE gates removal and withdrawal.
- Page guards: `requirePermission('products','READ')` at `/products/product-offering`; `requirePermission('products','EDIT')` at `/products/manage-products`, with DELETE re-checked per action.
- *(Manage rebuild)* **No new permission.** The new transitions distribute across the existing split:

| Action | Level |
|---|---|
| Create a version, edit a DRAFT (offering fields, specs, prices), add/update/delete a price row, submit for testing, return to draft, activate | `products : EDIT` |
| Discard (hard delete) a DRAFT or TESTING version, stop selling (ACTIVE → OBSOLETE), retire (OBSOLETE → RETIRED) | `products : DELETE` |

- Every action re-resolves the live principal, re-checks the level, and re-reads the target's `lifecycle_status` under `FOR UPDATE` **inside** its transaction immediately before deciding (code-standards §1.13) — unchanged rule, now covering five more transitions.
- Nav visibility follows the platform convention: denied pages are hidden from nav and the Homepage; the page guard remains the enforcement boundary.

*(Ordering update — unchanged)* `product_orders` and `product_inventory`, no grant overlap with `products`. Approval is permission + MANAGER role + reviewer ≠ submitter, enforced in the service and backstopped by a DB CHECK.

### Permission matrix

| Page (route) | Access | Required permission : level |
|---|---|---|
| `/products/product-offering` (View Product) | Authenticated | `products` : **READ** |
| `/products/manage-products` (list, panels, authoring, release) | Authenticated | `products` : **EDIT** |
| `/products/manage-products` — discard / obsolete / retire | Authenticated | `products` : **DELETE** |
| `/products/orders` (list + detail) | Authenticated | `product_orders` : **READ** |
| — create order | Authenticated | `product_orders` : **EDIT** |
| — approve / reject a `PENDING` order | Authenticated | `product_orders` : **EDIT** + MANAGER role + reviewer ≠ submitter |
| `/products/subscriptions` (list + history) | Authenticated | `product_inventory` : **READ** |
| — suspend / resume / terminate / edit characteristics | Authenticated | `product_inventory` : **EDIT** |

---

## 5. Background Tasks & AI

**None, in any phase.** No AI/ML components. No module jobs: price effectivity is resolved at query time from `start_date_time`, and *(Manage rebuild)* the retirement gate (§3.6) is likewise evaluated per request, at the moment the user acts — there is no sweeper that retires versions when their last subscription ends, and no scheduled revalidation of OBSOLETE rows.

**Audit events.** View Product reads are never audited. Every Manage Products mutation writes exactly one audit event inside the same transaction as the data change.

| Event | Phase | Note |
|---|---|---|
| `PRODUCT_OFFERING_CREATED / _UPDATED / _BRANCHED / _ACTIVATED` | shipped | unchanged |
| `PRODUCT_OFFERING_SUPERSEDED` | shipped, semantics changed | *(Manage rebuild)* `afterData.lifecycleStatus` becomes `OBSOLETE` |
| `PRODUCT_OFFERING_RETIRED` | shipped, semantics changed | *(Manage rebuild)* now means OBSOLETE → RETIRED, not ACTIVE → RETIRED |
| `PRODUCT_OFFERING_DISCARDED` | **removed** | *(Manage rebuild)* replaced by `PRODUCT_OFFERING_DELETED` |
| `PRODUCT_SPECIFICATION_CREATED / _UPDATED / _DELETED`, `PRODUCT_PRICE_ADDED` | shipped | unchanged |
| `PRODUCT_OFFERING_SUBMITTED_FOR_TESTING`, `PRODUCT_OFFERING_RETURNED_TO_DRAFT`, `PRODUCT_OFFERING_OBSOLETED`, `PRODUCT_OFFERING_DELETED`, `PRODUCT_PRICE_UPDATED`, `PRODUCT_PRICE_DELETED` | *(Manage rebuild)* | `_DELETED` on an offering carries the version id, name, version number and the counts of specs and prices removed — the only record left after a hard delete |

An optional free-text reason on a transition is carried in the audit payload (`transitionReason`), never as a column.

*(Ordering update)* Order and inventory events unchanged; subscription instantiation remains part of the order transaction, not a job.

---

## 6. Module Invariants

Platform Invariants (`architecture.md` §7) all apply, **with platform Inv. #18 amended as below**. Each rule here is testable and CI-enforceable.

1. **Price rows are immutable once their version leaves DRAFT.** *(AMENDED — Manage rebuild; pending design review, together with platform Inv. #18.)* While the parent offering is `DRAFT`, price rows may be updated and deleted: that content has never been orderable, never been billed, and is not a billing basis. From `TESTING` onward no code path may UPDATE or DELETE a price row. The price repository exports exactly three writes — `insertPrice`, `updatePrice`, `deletePrice` — and the latter two refuse any parent whose status is not `DRAFT`; a trigger (§3.5) enforces the same rule against direct SQL. *Original wording: "no code path UPDATEs or DELETEs a price row, in any phase" — it predated any editable draft state and made a typo in an unreleased draft permanently uncorrectable.*
2. **No overlapping effectivity.** Windows are derived `[start_date_time, successor start)`; two prices of one `price_type` on one offering never share a `start_date_time` — DB UNIQUE constraint, not app logic. Backdating beyond 3 days is rejected in the service (`BACKDATED_START_TOO_FAR`). *(Manage rebuild)* A successor price may only be **created** while the version is DRAFT, so an ACTIVE version's schedule is fixed at activation.
3. **`end_date_time` is never stored.** Derived from the successor's `start_date_time`. No `end_date_time` or `last_update` column exists on the price table.
4. **JSONB is schema-guarded.** Every write of `pricing_characteristics` or `product_spec_characteristics`, including seeds, is Zod-validated first; tiered tiers must be contiguous and non-overlapping.
5. **`amount` and tiers are mutually exclusive.** `flat` ⇒ `amount NOT NULL`, tiers NULL; `tiered` ⇒ `amount NULL`, tiers present. DB CHECK; Zod mirrors it.
6. **Only ACTIVE offerings are orderable; ACTIVE and OBSOLETE are billable; at most one ACTIVE per family.** *(AMENDED — Manage rebuild.)* Activating a version moves the family's previous ACTIVE version to `OBSOLETE` in the same transaction. `OBSOLETE` is not selectable for a new order and remains a full billing source for every subscription pinned to it. *Original wording retired the previous version and called it RETIRED, which collided with the new meaning of RETIRED (Inv. #23).*
7. **The audit log is never a rating or pricing source.** Historical basis is reconstructed from price rows + `start_date_time` only. *(Manage rebuild)* A hard-deleted DRAFT is the one thing that exists solely in the audit log — and it is, by construction, content that was never billable.
8. **`version` is a row's sequence number within its family**, assigned once at insert, never changed.
9. **Product tables live in the `product` schema** and reference the shared core by FK. The module creates no identity, RBAC, session, config or audit table. *(Manage rebuild)* Still exactly three tables — the rebuild adds columns' constraints, indexes and a trigger, never a table.
10. **READ gates everything on View Product.** No partial rendering of specs or prices under a weaker check.
11. **Writes flow exclusively through the mutation stack:** `actions/product/**` → `services/product/**` → repositories, gated by `products : EDIT`/`DELETE`. No other entry point exists, in any phase.
12. **The `(admin)` → `(app)` rename changed no URL.**
13. **Single-active and single-open per family are enforced by expression unique indexes, backed by the in-transaction lock.** *(AMENDED — Manage rebuild.)* `COALESCE(family_offering_id, product_offering_id)` removes the NULL-root problem; both predicates are index-enforced (§3.3), and `activateOffering` keeps its `FOR UPDATE` family lock and re-check. *Original wording declared a partial unique index impossible; that was tested and is false.*
14. **Editing a released version never mutates it in place.** *(AMENDED — Manage rebuild.)* An edit targeting an `ACTIVE` version clones the offering with all specifications and prices into a new `DRAFT` (`branchOfferingAsDraft`) and applies the edit there; the ACTIVE row and its children are provably untouched. A `TESTING` version is **not** branched — it is returned to `DRAFT` and edited directly, because it has never been orderable. `OBSOLETE` and `RETIRED` versions are not editable by any path; an edit starts from the family's ACTIVE version or a new draft.
15. **Order items and subscriptions are write-once at the billing-relevant core.** *(Ordering update)* Sole exception: `inventory.instance_characteristics`.
16. **Every price a customer pays is either an immutable catalog price row or an insert-only, manager-approved override row.** *(Ordering update)* No third source; no editable price column exists anywhere. *(Manage rebuild clarification)* A DRAFT price is not "a price a customer pays" — it cannot be ordered against, so Inv. #1's relaxation does not touch this rule.
17. **A catalog version referenced by any subscription is a rating source regardless of `lifecycle_status`.** *(AMENDED wording — Manage rebuild.)* Grandfathering makes `OBSOLETE` **and** `RETIRED` rows live billing data; no code path may assume `ACTIVE`-only when reading a pinned version.
18. **`inventory_status_history` is append-only and gap-free.** *(Ordering update)*
19. **One transaction per user action, TOCTOU-checked.** Every precondition is re-read under `FOR UPDATE` inside the transaction. *(Manage rebuild)* Applies to all five new transitions and to the retirement gate's subscription count.
20. **Cycle lives on the BAN.** No cycle, frequency or bill-run column in `ordering.*` or `inventory.*`. *(Manage rebuild)* The price's `recurring_charge_period_*` is **not** a cycle: it states the charge's own period, which the bill run maps onto the BAN's cycle. It stays on the price row and never migrates to a subscription.
21. **All billing dates are inclusive-billed.** *(Ordering update)* `start_date` = first billed day; `end_date` = last billed day. *(Manage rebuild)* This is why the retirement gate counts a TERMINATED subscription with `end_date >= current_date` as live (§3.6).
22. **Reviewer ≠ submitter, enforced server-side.** *(Ordering update)*

*Invariants 23–29 are introduced by the Manage Products rebuild.*

23. **The lifecycle is exactly `DRAFT → TESTING → ACTIVE → OBSOLETE → RETIRED`, plus `TESTING → DRAFT` and the hard delete of an unreleased version.** No other transition exists in code. `RETIRED` is terminal. `OBSOLETE` is reachable two ways — superseded by an activation, or stopped manually from `ACTIVE` — and by no other path. There is no direct `DRAFT → ACTIVE`, no `ACTIVE → DRAFT`, and no resurrection of an `OBSOLETE` or `RETIRED` version.
24. **Specification and price writes require a `DRAFT` parent, enforced in the database.** The repository refuses and the §3.5 trigger refuses; a direct SQL write against a released version's children fails. `TESTING` is read-only content — that is the whole difference between it and `DRAFT`.
25. **A version that was never `ACTIVE` may be hard-deleted; a version that was `ACTIVE` never may.** Discard removes a `DRAFT` or `TESTING` row with its specifications and prices in one transaction and writes `PRODUCT_OFFERING_DELETED`. No path deletes an `ACTIVE`, `OBSOLETE` or `RETIRED` offering, or any child of one. Because only an ACTIVE version can be branched from and only an ACTIVE version can be ordered, no order item or subscription can ever reference a deletable row.
26. **`RETIRED` means no live subscription.** The transition is refused while any subscription pinned to the version is not `TERMINATED`, or is `TERMINATED` with `end_date` today or later (§3.6). `RETIRED` is a labelling state: no row is deleted and every past period stays reproducible.
27. **One open version per family.** At most one row per family may be `DRAFT` or `TESTING` at a time, index-enforced. An edit against an `ACTIVE` version whose family already has an open version is redirected to that version rather than creating a second.
28. **A price is complete for its type, or it does not exist.** `recurring` carries a charge period the bill run can map onto a cycle and no unit of measure; `usage` carries a unit from the closed, case-sensitive list `Mbps` / `GB` / `MB` / `EA` and no charge period; `once` carries neither. Enforced by DB CHECK and mirrored in Zod, for seeds as much as for user input — the app may never again create a price the bill run cannot resolve.
29. **Manage may import View's read-only components; View imports nothing from Manage.** The dependency is one-directional and guardrail-enforced in that direction only. Duplicating the price or specification rendering to satisfy a mutual ban is a defect, not compliance.

### Guardrail re-scoping *(Manage rebuild)*

| Guardrail | Change |
|---|---|
| 2 — price immutability | Asserts immutability from `TESTING` onward, and asserts that `updatePrice`/`deletePrice` exist **and** refuse a non-DRAFT parent, including on a direct SQL write |
| 8 — single-active-per-family | Keeps the concurrency assertion; adds the index rejecting a direct second-ACTIVE insert, and the same for a second open version |
| 13 — schema-diff | Re-baselined to the new price-table shape (new CHECKs, cascade FKs) and the five-value enum, rather than removed |
| 16 — grandfathering | Asserts the superseded version is now `OBSOLETE` and the pinned subscription's resolved prices are byte-identical |
| 11 — View stays read-only | Unchanged in substance; its "and vice versa" companion assertion, if any, is dropped per Inv. #29 |

---

## 7. Known cross-module gaps this update does **not** close

Recorded here because a future reader will otherwise re-derive them:

- **Unit of measure has no shared vocabulary.** `product.product_offering_price.unit_of_measure`, `rating.udr_rated.udr_usage_unit` and `billing.customer_bill_line.unit` are three independent free-text columns. The unit a customer sees on a bill line comes from the **rating feed** (`min(udr_usage_unit)`, bm28), never from the price. Inv. #28 closes the product side only. rm07's feed profile writes the literal `'MBPS'` and `db/seeds/sample/udr-rated-sample.ts` writes `'EA'`; aligning them with the catalog's casing is a rating-phase hand-off.
- **Per-unit rating does not exist.** Rating v1 resolves `FLAT` only and ignores quantity; `PER_UNIT` is a stub (rm08). A tiered usage price therefore does not rate, and a tiered recurring price fails its account in bm29 (`RECURRING_PRICE_UNSUPPORTED`). By decision D13 the form allows both with a warning rather than blocking them.
- **`Mbps` is a rate, not a quantity.** A per-Mbps price needs a stated basis (per month, per peak sample). Not modelled.
- **Status literals outside this module.** Every comparison against `'RETIRED'` elsewhere must be reviewed when this update lands, including the flow SQL under `workflow-management/**`, because the value's meaning changes from "superseded or stopped" to "no subscription depends on it".
