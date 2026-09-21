# Product Management — Update Overview (Pricing Components: Capacity Commitment & Motivation)

**Module:** Product Management — pricing-component standardization (extends the Manage Products rebuild)
**Users:** Billing Operations authoring catalog prices (permission `products`, level EDIT) at the Manage Product level.
**Status:** Planned — JSON definitions and Product Management storage design locked in `_updatemodule-product-pricing-components-plan.md` (decisions PC1–PC14, invariants VI1–VI5, open items O1–O10; O3/O4 resolved).
**Companion docs:** `_updatemodule-product-pricing-components-plan.md` (authoritative), `prodmgmt-architecture.md`, `prodmgmt-code-standards.md`, `prodmgmt-project-overview.md`.

## Overview

This update replaces the catalog's two ad-hoc price shapes — a scalar `amount` column for flat prices and a `tiers[]` array for tiered prices — with **one standardized, composable pricing-component model**: every price on a product offering is a self-describing JSON object under a single envelope, discriminated by an `@type` field. It adds two algorithmic components authored at the Manage Product level — **Target Capacity Commitment** (a minimum billable-quantity floor) and **Target Capacity Motivation** (a graduated per-unit discount above a target quantity) — that combine with the base usage rate to price aggregated usage at BAN level during a later bill run. Each component projects 1:1 onto a TMF620 `pricingLogicAlgorithm`, so the model is TMForum-aligned without exposing any TMF API. This update covers **only** the JSON definitions and their Product Management persistence (schema, validation, services, UI, seeds); the bill-run computation, the rating engine's rate extraction, and the LookUp Rate Card table are explicitly later phases.

## Goals

1. Define one JSON **envelope** for every pricing component — `@type`, `specVersion`, `plaSpecId`, `priceType`, `appliesAt`, `basis`, `boundTo`, `params` — replacing `pricing_model` / `amount` / `pricing_characteristics`.
2. Add **Target Capacity Commitment**: bill `max(aggregatedQuantity, committedQuantity)`, so a customer under-using the committed capacity is still charged for it.
3. Add **Target Capacity Motivation**: a graduated per-unit rate — base rate below a target quantity, a reduced rate above it — expressed as an ascending `steps[]` array supporting N discount bands.
4. Turn the base usage rate into a `usage_rate` component, adding a `rateCardLookUp` reference (a LookUp Rate Card name, resolved by rating later) with `ratePerUnit` as the default and fallback rate.
5. Drop `pricing_model = 'tiered'`; the graduated concept lives on in `capacity_motivation.steps`.
6. Fold `flat` into the envelope (`usage_rate` for usage, `flat_fee` for recurring/once); document the negotiated override as a `negotiated_override` projection **without** reshaping its physical row.
7. Align to TMF620: each algorithmic component is a `pricingLogicAlgorithm` (named by `plaSpecId`); each plain-price component is a scalar `ProductOfferingPrice`; document one `plaSpec` per `@type` in the codebase.
8. Persist components by reshaping `product_offering_price` to `component_type` + `price_component` jsonb (Option A), edited in place in `0006_product.sql` under the fresh-install assumption — no migration, no backfill.
9. Enforce cross-component validity at the write boundary: a modifier requires a same-unit `usage_rate`; one currency per offering; exactly one effective `usage_rate` per unit.
10. Produce **one combined product charge per product per BAN** — components adjust a single running charge, not one bill line per component.

## Core User Flow

1. A Billing Operations user (`products : EDIT`) opens **Products → Manage Products**, selects a family, and opens or branches a `DRAFT` version.
2. In the pricing panel they add a **base usage rate** component: unit `EA`, `ratePerUnit` `"100"`, and optionally a `rateCardLookUp` name (the rate card itself is a later phase; absent → the flat `ratePerUnit` applies).
3. They add a **Target Capacity Commitment** component: `committedQuantity` `1000`.
4. They add a **Target Capacity Motivation** component: `steps` `[{ "aboveQuantity": 1000, "ratePerUnit": "50" }]`, optionally a second band such as `{ "aboveQuantity": 2000, "ratePerUnit": "25" }`.
5. On save, the form validates the components together — each modifier binds to the same-unit `usage_rate`, all share one currency, and `steps` are strictly ascending — and rejects any violation before write.
6. Each component is persisted as one `product_offering_price` row (`component_type` + `price_component` jsonb). A non-blocking **not-yet-billable warning** is shown, because bill-run support for the capacity components lands in a later phase.
7. The user submits the version for testing and activates it as usual; the components travel with the version and are grandfathered by the subscription's pinned version.
8. **(Later phase, defined here for reference)** At bill run, the components resolve to one combined charge per product per BAN: `Qbill = max(aggregatedQuantity, 1000)`, priced through `100` up to `1000` then `50` above — so `800 EA → 100,000` and `2000 EA → 150,000` (`+ 25 × (Q − 2000)` with the second band).

## Features

### Component envelope

- A single JSON envelope for every component: `@type` (discriminator), `specVersion`, `plaSpecId` (null for plain-price components), `priceType`, `appliesAt` (`rating` / `post_aggregation` / `billing`), `basis` (`quantity` / `flat`), `boundTo`, `params`.
- Validated by a Zod discriminated union on `@type`, each branch a `strictObject` (an unknown key is rejected, never stripped); the DB CHECK is the backstop.
- Money as decimal strings (`"100"`, `"50"`); quantities as numbers; `currency` and `unit_of_measure` stay on the row columns.

### The five components

- `usage_rate` (rating) — `params: { ratePerUnit, rateCardLookUp }`; the base per-unit rate that feeds rating.
- `flat_fee` (billing) — `params: { amount }`; fixed recurring/`oneTime` charge; scalar POP.
- `capacity_commitment` (post_aggregation) — `params: { committedQuantity }`; the quantity floor.
- `capacity_motivation` (post_aggregation) — `params: { steps: [{ aboveQuantity, ratePerUnit }] }`; the graduated rate schedule.
- `negotiated_override` (rating, ordering table) — `params: { ratePerUnit }`; **physical row unchanged**, projection only.

### Capacity mechanics

- Commitment applies a quantity floor; motivation applies a graduated rate schedule; the two compose as a transform pipeline (`Qbill = max(Q, committed)`, then price through the schedule) — correct even when `committedQuantity` exceeds the first step.
- The result is one combined product charge; an internal base / top-up / discount breakdown may be retained for audit but is not separate bill lines.

### TMF620 alignment

- `@type` + `plaSpecId` → `pricingLogicAlgorithm`; plain-price components → a scalar `ProductOfferingPrice.price`.
- `priceType` uses TMF values (`usage`, `recurring`, `oneTime`, `discount`) plus the documented extension `commitment` for the capacity floor.
- `boundTo` → a `popRelationship` (allowance/discount); `negotiated_override` → a `ProductPrice.priceAlteration`.
- One `plaSpec` description per `@type`, referenced by `plaSpecId`, is the in-codebase source of truth.

### Storage (Product Management)

- `product_offering_price` reshaped to `component_type text` (= `@type`, CHECK-constrained, indexed) + `price_component jsonb` (`$type<PricingComponent>`), retaining `currency`, `unit_of_measure`, `start_date_time`, recurring-period columns.
- `pricing_model`, `amount`, `pricing_characteristics`, and the legacy `price_type` column are dropped; a per-`component_type` completeness CHECK replaces the flat/tiered XOR.
- The uniqueness index rekeys to `(product_offering_id, component_type, unit_of_measure, start_date_time)`, preserving dated successors.

### Validation (write boundary)

- `steps` non-empty, `aboveQuantity` strictly ascending / non-duplicate / `> 0`, each `ratePerUnit` a money string.
- `committedQuantity` a finite number `> 0`.
- A `post_aggregation` modifier requires a same-unit `usage_rate` on the offering; exactly one effective `usage_rate` per `(offering, unit)`; a single currency across an offering's components.

## In Scope

- The envelope and its Zod discriminated union in a new `validation/product/pricing-component.schema.ts`, replacing `pricing-characteristics.schema.ts`; `tierSchema` and `tieredPricingCharacteristicsSchema` deleted.
- The five component definitions, including `capacity_commitment.committedQuantity` and `capacity_motivation.steps[]`, and the `usage_rate` `rateCardLookUp` field with its default/fallback precedence (definition only).
- Reshape of `product_offering_price` to `component_type` + `price_component` jsonb, the per-`component_type` CHECK, and the uniqueness-index rekey — edited in place in `0006_product.sql` under fresh-install (no migration, no backfill).
- DRAFT-only component writes reusing the pm38 service guard and the pm36 DRAFT-guard trigger; a new offering-level validator enforcing VI3–VI5 in the price-write services.
- Manage Products pricing-panel authoring for the new components, with the not-yet-billable warning.
- Seeds (`db/seeds/product.ts`, `demo/`, `sample/`) emitting the envelope; `types/product.ts` exporting `PricingComponent` and dropping `TieredPricingCharacteristics`.
- Dropping `pricing_model = 'tiered'` and its CHECK arm.
- One `plaSpec` doc-block per `@type` and the documented TMF620 mapping table (documentation, not an adapter).

## Out of Scope

- The bill-run computation: the capacity resolver, the `customer_bill_line` mapping, proration, rounding, and the BAN aggregation grain (O7–O9).
- The rating engine's rate extraction (`rp.py`) and any `PER_UNIT` / rate-card `udr_rate_detail` variant — rating currently has stubbed extraction only.
- The **LookUp Rate Card table** — referenced by name in `rateCardLookUp`; built and seeded separately.
- Any TMF620 external API or adapter — the mapping is documented for a future adapter; no adapter is built, and `app/api/product*` never exists.
- Reshaping the negotiated override's physical storage — it stays one row per `(order_item, price_type)`, insert-only, scalar `amount` + `currency` (Inv. #16).
- The `once` → `oneTime` rename on `ordering.order_item_price_override` (deferred, O2).
- Base-rate resolution semantics when a rate card or a negotiated override varies the per-unit rate the capacity modifiers compute against (O1/O6) — a bill-run decision.

## Success Criteria

- `npm run db:migrate` on an empty database produces `product_offering_price` with `component_type` + `price_component` and the per-`component_type` CHECK; `pricing_model`, `amount`, `pricing_characteristics`, and the legacy `price_type` column no longer exist; no backfill script exists.
- A `usage_rate`, a `capacity_commitment`, and a `capacity_motivation` can be authored on a `DRAFT` version and saved as three rows; the same components on a `TESTING`/`ACTIVE`/`OBSOLETE`/`RETIRED` version are refused by the repository and by the trigger.
- Each malformed component is rejected by Zod **and** at the database: non-ascending or duplicate `steps`, `committedQuantity ≤ 0`, a modifier with no same-unit `usage_rate`, and two components of one offering in different currencies.
- A `capacity_motivation` `steps: [{ aboveQuantity: 1000, ratePerUnit: "50" }]` plus a `capacity_commitment` `committedQuantity: 1000` over a `usage_rate` `ratePerUnit: "100"` reproduces the worked figures (`800 → 100,000`, `2000 → 150,000`, and `3000 → 175,000` with a `@25` second band) — asserted by a pure-function unit test of the composition contract, even though the bill-run wiring is a later phase.
- `pricing_model = 'tiered'`, `tierSchema`, and `TieredPricingCharacteristics` no longer exist anywhere in the codebase (guardrail).
- The negotiated override's physical shape is unchanged — still one row per `(order_item, price_type)`, insert-only — confirmed by the existing exported-surface guardrail.
- Every `@type` has a `plaSpec` doc-block and the TMF620 mapping table is documented in `pricing-component.schema.ts`, cross-linked from the module `AGENTS.md` and `README.md`.
- `npm run typecheck`, `lint`, and the full test suite pass; the schema-diff guardrail is green against the reshaped `product_offering_price`.
