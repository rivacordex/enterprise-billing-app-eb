# Product Management — Architecture (Module)

This document builds on `context/architecture.md`, which owns the platform-wide design — the technology stack, folder ownership, multi-module database design, the auth/authorization platform, storage principles and the platform invariants — and records **only what the Product Management module adds or changes**. Anything not stated here is inherited unchanged. This revision is scoped to the **Pricing Components update** (Target Capacity Commitment & Target Capacity Motivation); the delivered catalog, Ordering & Inventory and Manage Products rebuild architecture is the **baseline** it builds on, restated here only where the pricing update depends on it or changes it.

**Status:** IN PROGRESS. Decisions **PC1–PC14**, validation invariants **VI1–VI5** and open items **O1–O10** (O3/O4 resolved) are locked in `_updatemodule-product-pricing-components-plan.md` — the authoritative design. **pm46 has landed §3.2–§3.5's schema** (`0006_product.sql` + `db/schema/product.ts`) and §6's Inv. #2/#4/#5/#28/#30–#44 amendments (see §6); everything else in §3 remains unbuilt. Changes to _Module Invariants_ require a documented design review; the §6 amendments this unit lands are recorded as approved for schema purposes (workflow §7.1) — **G-B's own formal sign-off is tracked separately in `prodmgmt-ai-workflow-rules.md` and is not closed by this note.**

**Baseline (G-A correction, workflow §7.10): unverified, not "delivered."** The line below previously read "delivered, unchanged by this update." `prodmgmt-ai-workflow-rules.md` §0.1/G-A records that claim as **verified false** for the Manage Products rebuild (pm35–pm45): those units are implemented and unit/integration/type/lint-verified locally (`prodmgmt-progress-tracker.md`), but **G-0 — merge to `main` and the ship-gate SAST/DAST pass — is still open** as of this note (2026-09-21). Until G-0 closes, treat the five-value lifecycle, the expression unique indexes, the DRAFT-guard trigger and the retirement gate named below as the **target state this update builds against, not an observed fact in `main`.** This correction is owed in two more places per G-A (`prodmgmt-code-standards.md` §7/§9, the trackers); pm46 carries only this copy.

**Baseline (unchanged by this update, pending the G-A caveat above):** four pages — View Product (`/products/product-offering`), Manage Products (`/products/manage-products`), Orders (`/products/orders`), Subscriptions (`/products/subscriptions`); the five-value lifecycle `DRAFT → TESTING → ACTIVE → OBSOLETE → RETIRED`; the expression unique indexes for one-open and one-active per family; the DRAFT-guard trigger on both child tables; the retirement gate; three `product` tables.

**Scope of this update:** the JSON pricing-component envelope and its **Product Management persistence only** — schema, validation, services, repository, UI, seeds. It adds **no page, no route, no permission, no table and no stack component.** The bill-run computation, the rating engine's rate extraction, the LookUp Rate Card table and any TMF620 adapter are explicitly later phases and are **not** owned here.

**Companion docs:** `_updatemodule-product-pricing-components-plan.md` (authoritative), `prodmgmt-update-overview.md`, `prodmgmt-code-standards.md`, `prodmgmt-project-overview.md`, `_updatemodule-product-manage-page-refactor-plan.md` (the D11 fresh-install assumption this update reuses).

---

## 1. Technology Stack — Deltas Only

The stack is inherited wholesale from `architecture.md` §1. **This update introduces no new stack component, no new dependency, and no new runtime.** Notably it adds **no TMF620 library, SDK or adapter** — TMForum alignment is a documented projection (§3.6), not code.

| Layer | Technology (inherited) | Role in this update |
| --- | --- | --- |
| Frontend | Next.js ≥ 15 App Router + RSC, TypeScript `strict` | The Manage Products pricing panel (`PriceForm`, `ManagePricesPanel`) becomes a **component authoring surface**: one sub-form per `@type`, plus the non-blocking *not-yet-billable* warning (O10) shown while bill-run support is missing. URL-state convention (`?family=…&version=…`) unchanged. |
| APIs & Backend | Server Actions over framework-agnostic `services/` | Price mutations keep the standard action shape (`requirePermission` → `safeParse` → service → `revalidatePath`). **No `app/api/product*` route is added — and none ever exists**, including for TMF620. |
| Database | Azure PostgreSQL 17 via Drizzle ORM | `product_offering_price` is **reshaped** to a `component_type text` discriminator + a `price_component jsonb` envelope (§3.2). One row per component. Edited in place in `0006_product.sql` under the fresh-install assumption — no migration file, no backfill. |
| JSONB typing | Drizzle `$type<>` + Zod | `price_component` is typed `$type<PricingComponent>` and guarded by a **Zod discriminated union on `@type`**, each branch a `strictObject` (unknown key rejected, never stripped). The per-`component_type` DB CHECK is the backstop. |
| Validation | Zod in `validation/` | New `validation/product/pricing-component.schema.ts` replaces `pricing-characteristics.schema.ts`; `price-input.schema.ts` is rebuilt around components. First **offering-level (cross-row)** validator in the module — everything before it validated a single row. |
| Auth & Permissions | Better-Auth + core RBAC | **No new permission, no new level semantics, no new guard.** Component authoring sits inside the existing `products : EDIT` surface (§4). |
| Workflow engine | Kestra OSS + the custom Python worker (`workflow-management/**`) | **Not touched in this phase** — but it is a *reader* of the reshaped table and breaks on the column drops (§3.7). It is a separate runtime, bounded by Postgres grants, never imported by the app. |
| Caching / CDN | None | Unchanged. No component, rate or resolution result is cached; nothing about this update introduces a cache tier. |
| Background jobs / AI | None | Unchanged — see §5. The composition contract is a pure function, not a job. |
| Everything else | — | Unchanged: hosting, CI/CD, monitoring, backup/recovery, RLS unused, no rate limiting, no email. |

---

## 2. System Boundaries — Folder Ownership Deltas

Dependency rule unchanged: UI → actions → services → repositories → DB; inner layers never import outward. `components/`, `validation/`, `types/` remain shared leaves.

| Path | Owns | This update |
| --- | --- | --- |
| `validation/product/pricing-component.schema.ts` | **New.** The envelope, the discriminated union on `@type`, the five component branches, and the `plaSpec` doc-block catalog (PC11). | **Replaces `pricing-characteristics.schema.ts`**, which is deleted along with `tierSchema` and `tieredPricingCharacteristicsSchema`. This file is the in-codebase source of truth for the TMF620 mapping table. |
| `validation/product/price-input.schema.ts` | Shape of a price write from the form. | Rebuilt around components; per-`price_type` conditional requirements are re-keyed to `component_type`. |
| `services/product/insert-price.ts`, `update-price.ts`, `delete-price.ts` | Price write use cases. | Host the **new offering-level validator** enforcing VI3 (a modifier needs a same-unit `usage_rate`), VI4 (exactly one effective `usage_rate` per unit) and VI5 (one currency per offering). DRAFT-only writes and the 3-day backdating check are unchanged. |
| `db/repositories/product-offering-price.ts` | The only SQL for the price table. | Reads/writes `component_type` + `price_component`. Still exports exactly three writes (`insertPrice`, `updatePrice`, `deletePrice`), the latter two still refusing a non-`DRAFT` parent. |
| `db/schema/product.ts`, `db/migrations/0006_product.sql` | Drizzle schema + the in-place DDL. | Column drops, the two new columns, the per-`component_type` CHECK, and the uniqueness-index rekey (§3). Kept in sync by hand — no `drizzle-kit generate` (D11 carry-over). |
| `components/products/manage/**` | Write-capable UI. | Per-`@type` authoring sub-forms + the not-yet-billable warning. Import direction unchanged: `manage/**` may import View's read-only components; View imports nothing from `manage/`. |
| `db/seeds/product.ts`, `db/seeds/demo/product-demo.ts`, `db/seeds/sample/**` | Seed data. | Emit the envelope. Seeds are held to the same CHECKs and the same Zod validation as user input. |
| `types/product.ts` | Shared cross-layer types. | Exports the `PricingComponent` union; **drops `TieredPricingCharacteristics`**. |
| `actions/product/**` | One Server Action per mutation. | No new action file. `EXPECTED_PRODUCT_ACTION_FILES` is unchanged — the existing `insert-price` / `update-price` / `delete-price` actions carry the new payload. |
| `tests/**` | Units, integration, authz matrix, guardrails. | New component-validation and cross-component suites; the schema-diff guardrail (13) is re-baselined; a pure-function unit test asserts the composition contract's worked figures (§3.6) even though nothing computes them in production yet. **`tests/validation/pricing-characteristics.schema.test.ts` is deleted with its subject.** Fixtures outside the product suites also carry `pricing_model` — see §3.7. |

**What Product Management does _not_ own, and must not acquire.** The ownership line this update draws is as load-bearing as the folder table:

| Concern | Owner | Why it is not here |
| --- | --- | --- |
| The capacity resolver (`Qbill = max(Q, committed)`, then the graduated schedule) | Bill Run (`services/billing/**` + the engine) | Product defines and stores the components; it never prices them. A pricing computation inside `services/product/**` is a boundary violation. |
| `usage_rate` rate extraction + rate-card resolution (PC10) | Rating (`workflow-management/worker/workflow-engine/runtime/rp.py`) | A separate runtime with its own DB role; the app never imports it. |
| The **LookUp Rate Card** table | A later phase, owner undecided | `rateCardLookUp` is a **name only** in the envelope — an unresolved string, deliberately not an FK. |
| Any TMF620 adapter or external API | Nobody, by decision | The mapping is documented for a future adapter. `app/api/product*` never exists. |
| `ordering.order_item_price_override` | Ordering | `negotiated_override` is a logical projection; the physical row is not reshaped (PC9). |

---

## 3. Storage Model

### 3.1 What lives where

| Kind of state | Where | Rule under this update |
| --- | --- | --- |
| Pricing components | **Postgres**, `product.product_offering_price`, one row per component | The envelope is a JSONB column, not a sidecar table and not an array column (PC14; options B and C considered and set aside). |
| Currency, unit of measure, effectivity, recurring period | **Postgres columns** on the same row | Authoritative there, **never** inside `params`. The envelope echoes `unitOfMeasure` only inside `boundTo`, for binding. |
| The `plaSpec` catalog and the TMF620 mapping | **The codebase** — a doc-block in `pricing-component.schema.ts` | Documentation is the deliverable (PC11). No `pla_spec` table, no registry row. |
| Negotiated overrides | **Postgres**, `ordering.order_item_price_override` | Physical shape untouched: one row per `(order_item, price_type)`, insert-only, scalar `amount` + `currency`. |
| File storage | **None** | Unchanged from platform §3. This update stores no document, export or artifact. |
| Cache | **None** | Unchanged. No resolved rate, component or composition result is cached anywhere. |
| Rate-card entries | **Nowhere yet** | `rateCardLookUp` names a table that does not exist. An absent card falls back to `ratePerUnit` (PC10). |

### 3.2 The reshaped price row

| Column | Today (delivered) | After this update |
| --- | --- | --- |
| `product_offering_price_id` | text PK, `PRDOFP` + padded sequence | unchanged |
| `product_offering_id` | FK → `product_offering`, `ON DELETE cascade` | unchanged |
| `name` | text NOT NULL | unchanged |
| `price_type` | text NOT NULL, CHECK `recurring/usage/once` | **dropped** — superseded by `component_type`. Survives only on `ordering.order_item_price_override`, which narrows O2 to that one table. |
| `pricing_model` | text NOT NULL, CHECK `flat/tiered` | **dropped** |
| `amount` | numeric | **dropped** |
| `pricing_characteristics` | jsonb `$type<TieredPricingCharacteristics>` | **dropped** |
| `component_type` | — | **new.** text NOT NULL, CHECK-constrained to the persistable component enum, indexed. Always equals `price_component ->> '@type'`. |
| `price_component` | — | **new.** jsonb NOT NULL, `$type<PricingComponent>`, Zod-guarded at every write including seeds. |
| `currency` | text NOT NULL, `char_length = 3` | unchanged, and now cross-checked across the offering (VI5) |
| `unit_of_measure` | text, closed case-sensitive list `Mbps`/`GB`/`MB`/`EA` | unchanged in domain; its *requirement* is re-keyed from `price_type` to `component_type` |
| `recurring_charge_period_length` / `_type` | integer / text, closed set: `months` only, length ∈ (1, 3, 12) | retained; required for a `flat_fee` whose envelope `priceType` is `recurring` |
| `gl_code`, `policy` | text | unchanged (`policy` stays NULL and stays out of the form) |
| `start_date_time` | timestamptz NOT NULL | unchanged — billing effectivity; `end_date_time` is still **never stored** |
| `created_at` | timestamptz NOT NULL | unchanged |

Dropped with them: `product_offering_price_pricing_model_check`, `product_offering_price_amount_xor_tiers_check`, `product_offering_price_amount_check`, `product_offering_price_type_check`.

### 3.3 Per-`component_type` completeness

A per-`component_type` CHECK replaces the flat/tiered XOR — the DB mirror of VI1–VI2. It is the database's half of "a price is complete for its type, or it does not exist".

| `component_type` | Stage | Row columns required | Envelope `params` required | Persistable in this table |
| --- | --- | --- | --- | --- |
| `usage_rate` | rating | `unit_of_measure` NOT NULL; recurring period pair NULL | `ratePerUnit` money string; `rateCardLookUp` (nullable) | yes |
| `flat_fee` | billing | `unit_of_measure` NULL; recurring period pair present iff `priceType = 'recurring'` | `amount` money string | yes |
| `capacity_commitment` | post_aggregation | `unit_of_measure` NOT NULL; recurring period pair NULL | `committedQuantity` finite, `> 0` | yes |
| `capacity_motivation` | post_aggregation | `unit_of_measure` NOT NULL; recurring period pair NULL | `steps[]` non-empty; `aboveQuantity` strictly ascending, non-duplicate, `> 0`; each `ratePerUnit` a money string | yes |
| `negotiated_override` | rating | — | `ratePerUnit` | **no** — projection only; lives in `ordering` |

**The Zod union has five branches; the DB CHECK admits four.** `negotiated_override` is a logical/TMF projection, not a catalog row, so it must be excluded from the `component_type` CHECK enum. Admitting it would create a second, contradictory home for a negotiated price and break Inv. #16.

### 3.4 Uniqueness index rekey

```
-- delivered
UNIQUE (product_offering_id, price_type, start_date_time)      -- product_offering_price_type_start_unique
-- after this update
UNIQUE (product_offering_id, component_type, unit_of_measure, start_date_time)
```

One effective row per component per unit per start date. This is what preserves dated successors and backs VI4.

> **Design note — NULL collision, resolved (G-F, Khek, 2026-09-21).** `unit_of_measure` is NULL for `flat_fee`, and a plain UNIQUE index does not collide two NULLs, so two `flat_fee` rows sharing a `start_date_time` would both be accepted. Closed with **`UNIQUE NULLS NOT DISTINCT (product_offering_id, component_type, unit_of_measure, start_date_time)`** — a UNIQUE **constraint**, not a unique index, because drizzle-orm 0.45.2 exposes `nullsNotDistinct()` only on the unique-constraint builder (`product_offering_price_component_start_unique`). The `COALESCE(unit_of_measure, '')` expression-index form proposed earlier (the `product_offering`-family precedent) was **considered and rejected**: a sentinel string is excluded either way (pm46-spec D6). Landed in `0006_product.sql` + `db/schema/product.ts` by pm46.

### 3.5 JSONB governance

Platform §3 allows JSONB only where every write is validated against a Zod schema for the column's declared shape, "discriminated per type column where applicable, e.g. per `pricing_model`". That rule is unchanged; **its discriminator moves from `pricing_model` to `component_type`**, and the platform doc's example becomes stale — a one-line follow-up in `context/architecture.md` §3 when this update lands.

Money is a decimal string (`^\d+(\.\d+)?$`); quantities are numbers. No float ever represents money, in the envelope or in transit.

### 3.6 Migration mechanics and the composition contract

**Fresh install, D11 carry-over.** The product migrations are treated as not yet applied: `0006_product.sql` is edited in place, `db/schema/product.ts` is kept in sync by hand, the `0006` snapshot and `meta/_journal.json` stay unchanged, and every environment rebuilds its database. There is **no migration file and no backfill script** — their absence is a success criterion, not an omission. This relies on the verified fact that the migrator silently skips an already-applied, edited migration (`folderMillis` is compared; the `hash` column is written but never compared), so an edited `0006` reaches only databases built from scratch.

**The composition contract** is defined now and computed later, in Bill Run:

```
Q      = Σ aggregated quantity at BAN level
Qbill  = capacity_commitment ? max(Q, committedQuantity) : Q
charge = price Qbill through capacity_motivation's schedule
```

With `ratePerUnit = 100`, `committedQuantity = 1000` and step `@1000 → 50`: `800 → 100,000`; `2000 → 150,000`; `3000 → 175,000` with a second band `@2000 → 25`. Commitment (a quantity transform) always applies before motivation (a rate schedule), by class, deterministically — no `sequence` field is added (PC12). The result is **one combined charge per product per BAN**, never one line per component (PC5).

### 3.7 Cross-runtime consequence of the column drops

`product.product_offering_price` is read by two non-application runtimes and by Ordering. **Grants are table-level `SELECT`, not column-scoped** (`db/bootstrap/rating-db-roles.sql` step 7; `db/bootstrap/billrun-db-roles.sql` step 8), so the two new columns are readable with **no bootstrap role change** — the reshape is grant-transparent. The *drops* are not: they break reader SQL at parse time.

| Reader | Runtime / role | Depends on | Consequence |
| --- | --- | --- | --- |
| `workflow-management/worker/workflow-engine/runtime/rp.py` (RP price-resolution window) | `rating_runtime` | selected `popp.amount`, `popp.pricing_model`; **partitioned the effectivity window by `popp.price_type`** | **Re-keyed by pm51 (2026-09-22, G-G authorization granted).** Reads `component_type = 'usage_rate'` + `(price_component #>> '{params,ratePerUnit}')::numeric`; the window is partitioned by `(product_offering_id, component_type, unit_of_measure)` (pm51-spec D2/D5) so a second usage_rate lane or a capacity modifier on the same offering can never truncate another lane's `eff_to`. |
| `workflow-management/flows/bill-run-processor/bill_run_processing.template.yml` | `billrun_runtime` | as-of selection on `price_type = 'recurring'`, the `pricing_model = 'flat'` filter, the catalog `amount` | Same. Its bm29 recurring resolver reads `flat_fee.params.amount` after the reshape. |
| `services/ordering/order-preconditions.ts` | `app_runtime` | `price.priceType === override.priceType && price.pricingModel === 'flat'` to validate an override target | **Re-keyed by pm50 (2026-09-22, G-G authorization granted).** Override target resolution now reads `component_type` (`usage_rate` / `flat_fee` + the envelope `priceType` for the two `flat_fee` cases) via an explicit `Record<OverridePriceType, {...}>` lookup — pm50-spec D2/D3. |
| `validation/ordering/create-order.schema.ts` | `app_runtime` | documents the `flat` + `price_type` contract in comments | **Updated by pm50.** Contract text now describes the `usage_rate`/`flat_fee` component targets; the DB CHECK it mirrors is on the `ordering` table and is unchanged. |

**Test fixtures reach further still.** A repo sweep for `pricing_model` / `pricingModel` finds it seeded or asserted in the **rating** suites (`rm08-rp-price-resolution-snapshot`, `rm09-rl-guarded-transactional-load`, `rm10-supersession-reprocessing`, `rm13-e2e-journey`), the **bill-run** suites (`billrun-phase3-journey`, `billrun-recurring-aggregation`, `billrun-verification-reconciliation`, and the shared `tests/db/helpers/billrun-aggregate.ts`), the **ordering** suites (`create-order`, `review-order`, `ordering-read`, `subscription-lifecycle`), `ship-gate-guardrails`, and `db/seeds/sample/seed-billrun-sample.ts`. Reshaping the column set breaks each of them; none belongs to this module, and none is optional.

This is the single largest hazard in the update: **the blast radius of the drops is wider than the module.** Treat the reader inventory above — production and fixtures both — as the checklist, not the module's own file list.

### 3.8 Unchanged storage

Offerings and specifications, the three-table shape, the `PRDOFR`/`PRDSMD`/`PRDOFP` sequences, the cascade FKs, the DRAFT-guard trigger, the expression unique indexes, the retirement gate, and all of `ordering`/`inventory` are untouched. Historical billing basis is still reconstructed from price rows; **the audit log is forensics, never a rating or pricing source.**

---

## 4. Authentication & Access Model

Auth mechanics are inherited unchanged from platform §5 — Better-Auth DB-backed sessions, status and effective permissions loaded per request, never cached, never in the session.

**This update adds no permission, no level semantics, no page guard and no route.** Component authoring is ordinary DRAFT price editing under the existing split.

| Action | Level | Note |
| --- | --- | --- |
| Add / update / delete a pricing component on a `DRAFT` version | `products : EDIT` | Unchanged from the delivered price-write rules; the payload changes, the gate does not. |
| View a version's components on View Product | `products : READ` | READ still gates everything, including prices. No pricing-visibility split, and no separate gate for the capacity components. |
| Discard a `DRAFT`/`TESTING` version (cascading its components away) | `products : DELETE` | Unchanged. |

**The write boundary is unchanged and doubly enforced.** The action re-resolves the live ACTIVE principal and re-checks the level → the service re-reads `lifecycle_status` under `FOR UPDATE` inside the transaction → the repository refuses a non-`DRAFT` parent → the §3.8 trigger refuses a direct SQL write. The new offering-level validator (VI3–VI5) runs **inside** that same transaction, after the lock, because it reads sibling rows.

**No machine-to-machine surface is added.** No bearer-token endpoint, no `app/api/product*`, no external TMF620 API. The authz sweep gains no route, and the route × level matrix is unchanged.

**No ownership model change.** Components are catalog data owned by the version, not by a user; `last_edited_by` on the offering remains the only actor column. Customers (MNOs) remain domain data, not tenants — RLS stays unused.

---

## 5. Background Tasks & AI

**None, in this phase or any prior one. No AI/ML components anywhere in this module.**

- No job, sweeper or scheduled task is added. Component effectivity is resolved at query time from `start_date_time`, exactly as prices always were.
- The composition contract (§3.6) is a **pure function tested in isolation**, not a background task, and in this phase nothing in production calls it.
- The later-phase compute — the bill-run capacity resolver and RP's rate extraction — runs in the **workflow engine**, a non-application runtime that never executes in-process (platform §6). Nothing about that arrangement changes here.

**Audit.** No new event type. `PRODUCT_PRICE_ADDED`, `PRODUCT_PRICE_UPDATED` and `PRODUCT_PRICE_DELETED` keep their names; their before/after payloads now carry `component_type` + the `price_component` envelope in place of `price_type` / `pricing_model` / `amount`. One event per mutation, in the same transaction as the data change. View Product reads are still never audited.

---

## 6. Module Invariants

Platform invariants (`architecture.md` §7) all apply, including the Inv. #18 carve-out that lets a `DRAFT` version's prices be edited and hard-deleted. Module invariants 1–29 from the delivered baseline continue to apply, with the amendments below. Each rule here is testable and CI-enforceable.

**Landed by pm46 (2026-09-21):** Inv. **#2**, **#4** and **#28** are amended, **#5** is retired, and **#30–#44** are in force — the schema below (§3.2–§3.5) is now live in `0006_product.sql` + `db/schema/product.ts`, not a proposal. This is pm46 **landing** the text (workflow §7.1); it is not, by itself, **G-B**'s formal sign-off — `prodmgmt-ai-workflow-rules.md`'s own gate tracker still carries G-B as open, and that approval is tracked there, not manufactured here.

### Amended or retired by this update

| # | Rule | Change |
| --- | --- | --- |
| 2 | No overlapping effectivity | **Amended.** The uniqueness key becomes `(offering, component_type, unit_of_measure, start_date_time)` (§3.4). The derived window `[start, successor start)` and the 3-day backdating rejection are unchanged. |
| 4 | JSONB is schema-guarded | **Amended.** The guarded column is `price_component`, discriminated on `component_type`, validated by a `strictObject` union branch. Tier contiguity is carried over as VI1 (ascending, non-duplicate `steps`). |
| 5 | `amount` and tiers are mutually exclusive | **Retired.** Both columns are gone; replaced by the per-`component_type` completeness CHECK (§3.3). |
| 16 | Every price a customer pays is an immutable catalog row or an insert-only, approved override | **Reaffirmed, explicitly.** The override's physical row is not reshaped. This update creates no third price source. |
| 28 | A price is complete for its type, or it does not exist | **Amended.** Completeness is now keyed to `component_type`, not `price_type` (§3.3), and still binds seeds as tightly as user input. |

### New — introduced by the Pricing Components update

30. **One component per row, and the row never disagrees with the envelope.** `component_type` always equals `price_component ->> '@type'`. A row whose discriminator and envelope disagree is a corruption, not a variant — asserted in the database and in tests.
31. **The Zod discriminated union is the only writer of `price_component`.** Every write — action, service, seed, fixture — parses first. Each branch is a `strictObject`: an unknown key is **rejected, never silently stripped**. The DB CHECK is the backstop, never the primary guard.
32. **Money is a decimal string; quantities are numbers; currency and unit live on columns.** No float represents money anywhere in the envelope. `currency` and `unit_of_measure` are authoritative on the row; `params` never restates them, and `boundTo.unitOfMeasure` exists only to express binding.
33. **A `post_aggregation` modifier never stands alone.** (VI3) A `capacity_commitment` or `capacity_motivation` requires a rating-stage `usage_rate` of the **same `unit_of_measure`** on the same offering; its base rate would otherwise be unresolvable. This is an offering-level check, enforced in the price-write services inside the DRAFT lock.
34. **Exactly one `usage_rate` is effective per `(offering, unit_of_measure)` at any instant.** (VI4) Dated successors are allowed; ambiguity is not. Index-backed by §3.4.
35. **One currency per offering's combinable components.** (VI5) A modifier never mixes currencies with its base component.
36. **Components compose into one charge per product per BAN.** (PC5) No component is ever its own bill line. An internal base / top-up / discount breakdown may be retained for audit; it is not a line.
37. **Apply order is canonical, by stage then class.** (PC12) Quantity transforms (`capacity_commitment`) apply before rate schedules (`capacity_motivation`). No `sequence` column exists; adding one is a reviewed decision, not a convenience.
38. **The envelope's `priceType` is never mapped onto a `price_type` column.** (PC13) They are different axes — TMF (`usage` / `recurring` / `oneTime` / `discount` / `commitment`) versus the legacy column (`recurring` / `usage` / `once`, now surviving only on `ordering.order_item_price_override`). No code or document may equate them silently.
39. **`negotiated_override` is a projection, never a catalog row.** It is excluded from the `component_type` CHECK enum and cannot be inserted into `product_offering_price`. Its physical storage — one insert-only row per `(order_item, price_type)` in `ordering` — is unchanged (PC9).
40. **TMF620 alignment is documentation, never a runtime dependency.** No adapter, no SDK, no external API, no `app/api/product*` — in this phase or any other. Every `@type` carries a `plaSpec` doc-block and the mapping table lives in `pricing-component.schema.ts` (PC11); that catalog *is* the compliance artifact.
41. **`tiered` no longer exists anywhere.** `pricing_model`, `tierSchema`, `tieredPricingCharacteristicsSchema` and `TieredPricingCharacteristics` are absent from schema, validation, types, seeds, tests and UI. Guardrail-enforced by absence, not by convention.
42. **`rateCardLookUp` is a name, not a reference.** It is an unresolved string with no FK and no table behind it. An absent card or a `"default"` entry falls back to `ratePerUnit`; a null `rateCardLookUp` always uses `ratePerUnit` (PC10). Nothing may treat it as resolvable until the rate-card phase exists.
43. **Product defines and stores components; it never prices them.** No pricing computation — no capacity resolver, no schedule evaluation, no rate-card lookup — lives in `services/product/**` or `db/**`. The composition contract is tested here as a pure function and executed in Bill Run.
44. **`specVersion` is present on every stored envelope.** It is the forward-migration hook; a reader that ignores it is a defect, and a shape change without incrementing it is a breaking change disguised as a patch.

### Guardrail re-scoping

| Guardrail | Change |
| --- | --- |
| 2 — price immutability | Unchanged in substance; its fixtures move to the component payload. Still asserts `updatePrice` / `deletePrice` refuse a non-`DRAFT` parent, including on a direct SQL write. |
| 13 — schema-diff | Re-baselined to the reshaped price table: the two new columns, the per-`component_type` CHECK, the rekeyed uniqueness index, and the four dropped columns. |
| 16 — grandfathering | Extended: a pinned subscription's resolved components must be byte-identical after an activation, envelope included. |
| **new** — no `tiered` residue | Asserts the absence of `pricing_model`, `tierSchema`, `tieredPricingCharacteristicsSchema` and `TieredPricingCharacteristics` across the repository (Inv. #41). |
| **new** — override shape frozen | Asserts `ordering.order_item_price_override` still exposes exactly its scalar `amount` + `currency`, insert-only surface (Inv. #39). |

---

## 7. Known gaps this update does **not** close

Recorded so a future reader does not re-derive them. Each maps to an open item in `_updatemodule-product-pricing-components-plan.md`.

- **Nothing bills the capacity components.** The resolver, the `customer_bill_line` mapping, proration of `committedQuantity`, the combined-charge rounding policy, and the BAN aggregation grain are all undecided (O7–O9). Until then the UI shows a non-blocking not-yet-billable warning (O10) — a user can author a component the system cannot yet charge for. That is a deliberate, declared state, not a defect.
- **Base-rate semantics under a varying rate card are undefined** (O1, extended by O6). When `rateCardLookUp` yields different per-UDR rates, "the base rate" the capacity modifiers compute against — effective, weighted, or the declared `ratePerUnit` — is a bill-run decision. The same question applies when a negotiated override displaces the catalog rate.
- **Effectivity-aware binding resolution is unspecified** (O5). VI4 guarantees one effective `usage_rate` per unit *at an instant*; which one a modifier binds to across a period containing a dated successor is not yet decided.
- **`once` → `oneTime` is deferred** (O2). The envelope uses the TMF value; `ordering.order_item_price_override.price_type` still stores `once`. Two vocabularies coexist until that rename lands — which is exactly why Inv. #38 exists.
- **Unit of measure still has no shared vocabulary.** `product.product_offering_price.unit_of_measure`, `rating.udr_rated.udr_usage_unit` and `billing.customer_bill_line.unit` remain three independent columns, and the unit on a bill line still comes from the rating feed, never from the price. The capacity components bind **by unit** (PC4 / VI3), which makes that divergence newly consequential — a same-unit match that is only textually same-unit.
- **`Mbps` is a rate, not a quantity.** A per-Mbps commitment or motivation needs a stated basis (per month, per peak sample) that is still not modelled — and the capacity components are quantity-based, so this is now a live modelling question rather than a latent one.
