# Product Management — Pricing Components (JSON Definition & TMF Mapping)

**Module:** Product Management — pricing-component standardization (extends the Manage Products rebuild, `prodmgmt-update-overview.md`)
**Users:** Revenue Operations (permission `products`, EDIT/DELETE) at the Manage Product level.
**Status:** Design. Locks decisions **PC1–PC13**; validation invariants **VI1–VI5**; open items **O1–O10** (O4 resolved — see PC14).
**Scope now:** the JSON shape of every pricing component at the Manage Product level, its TMForum projection, **and the Product Management storage & implementation design** (schema, validation, services, UI, seeds — designed here, built later). **Not** in scope to *build* now: the bill-run computation, the rating engine's extraction logic (stubbed template only today), the LookUp Rate Card table, and any TMF620 API/adapter.
**Companion docs:** `prodmgmt-architecture.md`, `prodmgmt-code-standards.md`, `prodmgmt-update-overview.md`, `bm29-real-aggregation-recurring-price-resolver.md` (recurring consumer), `rm01`/`rm08` (rating + usage-price consumers), `db/schema/rating/udr-rated.ts` (aggregation source).

---

## Overview

The catalog today stores a price two ways at once: a scalar on the `product_offering_price.amount` column (`pricing_model='flat'`), or a `tiers[]` array in the `pricing_characteristics` JSONB (`pricing_model='tiered'`), under an XOR CHECK (`db/schema/product.ts:187`). Negotiated prices live as a third shape — a scalar `amount` in `ordering.order_item_price_override`. Three shapes, no common envelope, and no home for algorithmic pricing.

This design introduces **one JSON envelope for every pricing component** and adds two algorithmic components — **Target Capacity Commitment** and **Target Capacity Motivation** — that the bill run will apply over rated, aggregated UDR at BAN level. Because the rating engine has no component-extraction logic yet (stub template only), standardizing now is close to free.

The envelope is a deliberate **1:1 projection of a TMF620 `pricingLogicAlgorithm`** (`@type`/`plaSpecId` + open `params`), so a future TMF620 adapter is mechanical while internal storage stays simple. TMF620 has no declarative tiers and no minimum-commitment type; its own guidance is to model exactly this kind of thing as a `pricingLogicAlgorithm` — so framing our components as PLAs is the compliant path, not a divergence.

---

## Decisions (locked)

- **PC1 — One envelope, discriminated on `@type`.** Every pricing component is a single JSON object with a fixed envelope (below). `@type` is the discriminator (TMF-native); it replaces the old `pricing_model` idea. No component carries its shape in a table column.
- **PC2 — Zod-validated, discriminated union on `@type`.** Mirrors `priceCharacteristicsSchema` (`pricing-characteristics.schema.ts`). A forbidden key is an unrecognized key (`strictObject`), never silently stripped. The DB CHECK is the backstop (added in a later storage phase).
- **PC3 — Money as decimal strings, quantity as numbers.** `"100"`, `"50.5"` for money (regex `^\d+(\.\d+)?$`); `1000` for quantities. `currency` and `unitOfMeasure` remain **row columns** (single source of truth); the envelope echoes `unitOfMeasure` only inside `boundTo`, for binding.
- **PC4 — Binding is implicit, by unit (Option A).** A modifier resolves its base rate from the offering's rating-stage component of the same `unitOfMeasure`. Its **TMF projection is a `popRelationship`** (allowance/discount), derived by the adapter from `boundTo`. No explicit price-id pointer.
- **PC5 — One combined product charge.** All components for a product resolve to a **single charge line per product per BAN** — not one bill line per component. An internal breakdown may be retained for audit; it is not separate bill lines.
- **PC6 — Algorithmic components are TMF `pricingLogicAlgorithm` instances.** `@type` == the PLA type; `plaSpecId` names its specification; `params` are the PLA's open parameters. Plain price components (`flat_fee`, `usage_rate` with no rate card) project to a **scalar POP price** and carry no `plaSpecId`.
- **PC7 — Adopt TMF `priceType` vocabulary.** `usage`, `recurring`, `oneTime` (renamed from `once`), `discount`. `capacity_commitment` uses the extension value `commitment` — TMF `priceType` is an open enum ("*such as recurring, discount, allowance, penalty*"), and no native value means "minimum commitment / floor"; `allowance` means the opposite (included units) and must not be reused.
- **PC8 — Drop `pricing_model='tiered'`.** Graduated pricing lives in `capacity_motivation.steps`. The tier-contiguity invariant (Inv. #4) carries over as ascending/non-duplicate `aboveQuantity` validation. Nothing bills tiered today, so no capability is lost.
- **PC9 — Fold `flat` into the envelope; project the override, do not reshape it.** Flat is genuinely reshaped: it becomes `usage_rate` (usage) or `flat_fee` (recurring/oneTime). The negotiated override **keeps its current physical format** — one row per `(order_item, price_type)`, insert-only, scalar `amount`+`currency` (Inv. #16) — and is **not** restructured. `negotiated_override` is only its **logical/TMF projection** (`ProductPrice.priceAlteration`, TMF622/637), used for documentation and the future adapter. One-per-`(item, price_type)` is TMF-compatible: `priceAlteration` is an array, and constraining it is a business rule, not a spec violation.
- **PC10 — `usage_rate` rate resolution precedence.** (1) `rateCardLookUp` set → resolve from the named LookUp Rate Card; (2) no card entry, or the entry points to "default" → fall back to `ratePerUnit`; (3) `rateCardLookUp` null → always `ratePerUnit`. The rating logic owns this; the card table is separate.
- **PC11 — Document the envelope in the codebase.** One `plaSpec` description per `@type` lives in the doc-block of a new `validation/product/pricing-component.schema.ts` (where flat/tiered invariants live today), referenced by `plaSpecId`, and cross-linked from the product-management `AGENTS.md`, the rating module docs, and `README.md`. The `plaSpec` catalog *is* the required documentation.
- **PC12 — Deterministic apply order.** Within `post_aggregation`, components apply by class: **quantity-transform** (`capacity_commitment`) before **rate-schedule** (`capacity_motivation`). Order is canonical per stage-then-class; no `sequence` field is added yet. A `sequence: integer` is introduced only when a solution needs arbitrary ordering among same-class components (deferred; recorded so it is a considered omission, not a gap).
- **PC14 — Physical storage: reshape the row (O4 resolved).** `product_offering_price` holds **one row per component**: a `component_type text` discriminator (= `@type`, CHECK-constrained, indexable) plus a `price_component jsonb` envelope (`$type<PricingComponent>`), retaining `currency`, `unit_of_measure`, `start_date_time` and the recurring-period columns. `pricing_model`, `amount` and `pricing_characteristics` are **dropped**. A per-`component_type` completeness CHECK replaces the flat/tiered XOR (the DB mirror of VI1–VI2). Legacy `price_type` on the offering price is **dropped** in favour of `component_type`; `price_type` survives only on `ordering.order_item_price_override` (so O2 now scopes to that one table). Edited in place in `0006_product.sql` under fresh-install — no migration, no backfill.
- **PC13 — Envelope `priceType` ≠ column `price_type`.** The envelope's `priceType` is the **TMF axis** (`usage`/`recurring`/`oneTime`/`discount`/`commitment`). It is *not* the legacy `product_offering_price.price_type` column (`recurring`/`usage`/`once`). The modifier components (`capacity_commitment`, `capacity_motivation`, `negotiated_override`) have **no legacy `price_type`** — they do not fit that column's CHECK and therefore cannot be persisted as ordinary price rows. Their storage home is `component_type` + `price_component` storage (**O4, resolved by PC14**), except `negotiated_override`, which stays a logical projection over `ordering.order_item_price_override` (PC9). Docs and code must never map one axis onto the other silently.

---

## The component envelope

```jsonc
{
  "@type":       "capacity_motivation",     // discriminator; TMF polymorphic type
  "specVersion": 1,                          // envelope version for forward migration
  "plaSpecId":   "PLA_CAPACITY_MOTIVATION",  // TMF PricingLogicAlgorithm spec ref; null for plain price components
  "priceType":   "discount",                 // TMF priceType (PC7)
  "appliesAt":   "post_aggregation",         // "rating" | "post_aggregation" | "billing"
  "basis":       "quantity",                 // what it consumes: "quantity" | "flat" (reserved: "amount")
  "boundTo":     { "unitOfMeasure": "EA" },  // implicit binding (PC4); null when self-contained
  "params":      { /* @type-specific */ }
}
```

| Field | Type | Meaning |
|---|---|---|
| `@type` | string (enum) | Component discriminator. One of the catalog below. |
| `specVersion` | integer | Envelope schema version. |
| `plaSpecId` | string \| null | TMF `PricingLogicAlgorithm.plaSpecId`. Present for algorithmic components; `null` for `flat_fee` / plain `usage_rate`. |
| `priceType` | string (enum) | TMF `ProductOfferingPrice.priceType`. |
| `appliesAt` | string (enum) | Pipeline stage that consumes it. |
| `basis` | string (enum) | `quantity` (per-unit / aggregated qty) or `flat` (fixed amount). |
| `boundTo` | object \| null | Implicit binding key (`unitOfMeasure`, optionally `priceType`). |
| `params` | object | Per-`@type` parameters, validated by the union branch. |

---

## TMF620 mapping (baked in)

| Envelope concept | TMF620 target | Notes |
|---|---|---|
| the component object | `ProductOfferingPrice` (POP) | one POP per component |
| `@type` | `@type` | polymorphic type; the PLA/POP subtype |
| algorithmic component (`params`) | `pricingLogicAlgorithm[]` + `plaSpecId` | TMF's sanctioned home for "external rating function" pricing |
| plain price component | POP `price` (`Money{value,unit}`) | scalar; no PLA |
| `priceType` | `priceType` | open enum; `commitment` is a documented extension |
| `boundTo` (PC4) | `popRelationship[]` | allowance/discount relationship to the base POP; adapter-derived from unit |
| money string + `currency` column | `Money { value, unit }` | mapped at the adapter |
| `unitOfMeasure` column | `Quantity { amount, units }` | mapped at the adapter |
| `capacity_motivation.steps` | PLA params | TMF has no first-class tiers; steps live inside the PLA |
| `negotiated_override` | `ProductPrice.priceAlteration` (TMF622/637) | order-level alteration, not a catalog POP |

Compliance verdict: **structurally aligned, not literally TMF620-conformant** — which matches the module's stance (TMF-shaped internally; external TMF620 API forbidden, `prodmgmt-update-overview.md`). The envelope adds `@type` + `plaSpecId` + a `priceType` tag so the module sits one mechanical adapter away from TMF620, with `capacity_commitment` as an openly-declared extension.

---

## Component catalog (applicable now)

The worked scenario throughout: base `ratePerUnit = 100`, `committedQuantity = 1000`, motivation step `aboveQuantity 1000 @ 50`, unit `EA`, currency `MYR`.

### 1. `usage_rate` — base per-unit rate (rating stage)

```json
{
  "@type": "usage_rate",
  "specVersion": 1,
  "plaSpecId": null,
  "priceType": "usage",
  "appliesAt": "rating",
  "basis": "quantity",
  "boundTo": { "unitOfMeasure": "EA" },
  "params": { "ratePerUnit": "100", "rateCardLookUp": null }
}
```

Replaces flat usage. Feeds the rating engine per UDR. `plaSpecId` becomes `PLA_USAGE_RATE` **only** when `rateCardLookUp` is set (card-driven rating is algorithmic → a PLA). Resolution precedence: PC10.

### 2. `flat_fee` — fixed amount (billing stage)

```json
{
  "@type": "flat_fee",
  "specVersion": 1,
  "plaSpecId": null,
  "priceType": "recurring",
  "appliesAt": "billing",
  "basis": "flat",
  "boundTo": null,
  "params": { "amount": "100" }
}
```

Replaces flat recurring/once. `priceType` is `recurring` (bm29 recurring compute) or `oneTime`. `recurring_charge_period_length/_type` stay on columns. Projects to a scalar POP price.

### 3. `capacity_commitment` — Target Capacity Commitment (post-aggregation)

```json
{
  "@type": "capacity_commitment",
  "specVersion": 1,
  "plaSpecId": "PLA_CAPACITY_COMMITMENT",
  "priceType": "commitment",
  "appliesAt": "post_aggregation",
  "basis": "quantity",
  "boundTo": { "unitOfMeasure": "EA" },
  "params": { "committedQuantity": 1000 }
}
```

Quantity floor: `Qbill = max(aggregatedQty, committedQuantity)`. Bills at least the committed quantity even when the customer under-uses. Extension `priceType` (PC7).

### 4. `capacity_motivation` — Target Capacity Motivation (post-aggregation)

```json
{
  "@type": "capacity_motivation",
  "specVersion": 1,
  "plaSpecId": "PLA_CAPACITY_MOTIVATION",
  "priceType": "discount",
  "appliesAt": "post_aggregation",
  "basis": "quantity",
  "boundTo": { "unitOfMeasure": "EA" },
  "params": {
    "steps": [
      { "aboveQuantity": 1000, "ratePerUnit": "50" }
    ]
  }
}
```

Graduated rate curve: base rate below the first `aboveQuantity`, each step's `ratePerUnit` above its threshold. `steps` is ascending and non-duplicate (Inv. #4 carried over) and extends to N bands, e.g. a second `{ "aboveQuantity": 2000, "ratePerUnit": "25" }`.

### 5. `negotiated_override` — order-level override (rating stage, ordering table)

```json
{
  "@type": "negotiated_override",
  "specVersion": 1,
  "plaSpecId": null,
  "priceType": "discount",
  "appliesAt": "rating",
  "basis": "quantity",
  "boundTo": { "priceType": "usage", "unitOfMeasure": "EA" },
  "params": { "ratePerUnit": "85" }
}
```

Overrides the resolved `usage_rate` for one order item. **Physical storage is unchanged** — `ordering.order_item_price_override`, one row per `(order_item, price_type)`, insert-only/immutable (Inv. #16), scalar `amount`+`currency`. This envelope is the **logical/TMF projection only** (`ProductPrice.priceAlteration`), not a stored JSONB shape and not a catalog POP (PC9).

### Dropped — `tiered`

`pricing_model='tiered'`, `tieredPricingCharacteristicsSchema`, `tierSchema`, and the tiered arm of the XOR CHECK are removed (PC8). The graduated concept lives on in `capacity_motivation.steps`.

---

## Composition contract (bill run — later phase, defined here for reference)

Per product, per BAN, over the live rated UDR set (`rating.udr_rated`, grouped by re-derived `billrun_ban_id`, `udr_price_ref`, `udr_currency`):

```
baseRate = resolved usage_rate for the unit (PC4)      # from the rating component / rated line
Q        = Σ udr_usage_quantity                        # aggregated quantity
Qbill    = capacity_commitment ? max(Q, committedQuantity) : Q
charge   = price Qbill through capacity_motivation's schedule
           ( [0 .. step1] @ baseRate, [step1 .. step2] @ rate1, ... )
```

| usage `Q` | `Qbill` | charge |
|---|---|---|
| 800 | 1000 | 100 × 1000 = **100,000** |
| 2000 | 2000 | 100×1000 + 50×1000 = **150,000** |
| 3000 (with 2nd step @25) | 3000 | 100×1000 + 50×1000 + 25×1000 = **175,000** |

Applied as a transform pipeline (commitment adjusts quantity, motivation adjusts the rate schedule), the result stays correct even when `committedQuantity > firstStep` — topped-up units are priced through the same schedule.

---

## Validation invariants

Enforced by Zod at the write boundary (PC2), mirrored by the DB in the storage phase.

- **VI1 — `capacity_motivation.steps`** is non-empty; `aboveQuantity` strictly ascending, non-duplicate, and `> 0`; each `ratePerUnit` a money string (`^\d+(\.\d+)?$`). This is Inv. #4 (tier contiguity) carried over from the dropped `tiered` model.
- **VI2 — `capacity_commitment.committedQuantity`** is a finite number `> 0`.
- **VI3 — Base-component presence (cross-component).** Any `post_aggregation` modifier requires a rating-stage `usage_rate` of the **same `unitOfMeasure`** on the same offering — otherwise its base rate is unresolvable (PC4). This is a new **offering-level** validation; existing price validation is per-row.
- **VI4 — Unambiguous binding.** For a given (offering, `unitOfMeasure`), exactly one `usage_rate` is *effective* at any instant. Dated successors are allowed (per the rebuild), but a modifier must resolve to exactly one base rate at the candidate's exact `start_date_time` — validated instant-by-instant, never as a period-wide rule.
- **VI5 — Single currency.** All combinable components of one offering share one `currency` (the column). A modifier never mixes currencies with its base component.

---

## Product Management — storage & implementation (this module)

"Storage-phase" is **this module**: persisting the envelope in the `product` schema, wiring validation, seeds, services and UI. Because the Manage Products rebuild runs under the **fresh-install assumption** (D11, `_updatemodule-product-manage-page-refactor-plan.md` — no installation exists; every environment rebuilds its DB), `product_offering_price` can be **edited in place** (as pm35 edits `0006_product.sql`) with **no migration or backfill**.

### Schema — `db/schema/product.ts` + `0006_product.sql` (decision O4)

Locked shape (**Option A / O4 resolved → PC14**): replace the `pricing_model` / `amount` / `pricing_characteristics` triple with

- `component_type text` — the `@type`, CHECK-constrained to the component enum, indexable;
- `price_component jsonb` — the envelope, `$type<PricingComponent>` (Zod-guarded);
- retain `currency`, `unit_of_measure`, `start_date_time`, and the recurring-period columns.

Removed: the `pricing_model` CHECK, the flat/tiered `amount`-XOR-tiers CHECK, and the legacy `price_type` column (superseded by `component_type`; `price_type` lives on only in `ordering.order_item_price_override`). Added: a per-`component_type` completeness CHECK (e.g. `usage_rate` ⇒ `unit_of_measure` present; `flat_fee` ⇒ `params.amount`), the DB mirror of VI1–VI2. The existing uniqueness index `product_offering_price_type_start_unique` (`product_offering_id, price_type, start_date_time`) **rekeys** to `(product_offering_id, component_type, unit_of_measure, start_date_time)` — one effective row per component per unit per start date, which is what preserves dated successors and backs VI4.

### Validation — `validation/product/pricing-component.schema.ts`

Replaces `pricing-characteristics.schema.ts`. The Zod discriminated union on `@type` (PC1/PC2); `tierSchema`/`tieredPricingCharacteristicsSchema` deleted; `steps` carries Inv. #4 (VI1). `price-input.schema.ts` is rebuilt around components. **New: an offering-level validator** — VI3 (a modifier needs a same-unit `usage_rate`), VI4 (unambiguous binding), VI5 (single currency) — because today every price validates per-row; a cross-row check does not exist yet. It lands in the price-write services (below), the pattern pm38 used for the discriminated price-input schema.

### Services — `services/product/insert-price.ts`, `update-price.ts`, `delete-price.ts`

Accept components; enforce VI3/VI5 against the offering under the existing DRAFT lock; DRAFT-only writes and the backdating check are unchanged (pm38 service guard + pm36 trigger remain the backstop).

### Repository — `db/repositories/product-offering-price.ts`

Read/write the new `component_type` + `price_component` columns; the DRAFT-guard trigger (pm36) is untouched.

### UI — `components/products/**` (`PriceForm`, `ManagePricesPanel`)

Author `usage_rate` (+ `rateCardLookUp`), `flat_fee`, `capacity_commitment`, `capacity_motivation` inline on a DRAFT; the **not-yet-billable warning** (O10) shows until the bill-run phase supports the modifiers (the pm38 warning pattern for tiered shapes).

### Seeds & types — `db/seeds/product.ts`, `demo/product-demo.ts`, `sample/**`, `types/product.ts`

Seeds emit the envelope; the fresh-install CHECKs reject a malformed component. `types/product.ts` exports the `PricingComponent` union and drops `TieredPricingCharacteristics`.

**Coverage:** with the above, Product Management is fully covered at plan level. **O4** (physical representation) is resolved (PC14); everything else is derivable from plan intention + codebase.

---

## Later planned modules & components

Everything below is a **later phase**, outside this JSON+PM-storage scope, recorded so the downstream work is visible. Two spots do the real new computation — RP rate resolution and the bill-run capacity resolver.

### Rating Management (rate resolution)

| Component | Change | Item |
|---|---|---|
| `workflow-management/worker/workflow-engine/runtime/rp.py` (RP price resolution) | Extract `usage_rate` + `rateCardLookUp`; apply the card with default fallback — the stubbed extraction becomes real | PC10 |
| `validation/rating/udr-rate-detail.schema.ts` | Add a `PER_UNIT` / rate-card variant (the `udr_rate_type` CHECK already lists `PER_UNIT`, no computation) | — |
| `db/schema/rating/udr-rated.ts` | Likely no column change — `udr_usage_rate`, `udr_price_ref`, `udr_rated_price` already carry it; `udr_rate_type` may become `PER_UNIT` | — |
| **LookUp Rate Card table** (new) | New table + seeds + the resolution join — its own phase | PC10 |
| `workflow-management/flows/rating-engine/ran-usage-rating.yaml` | RP-stage wiring for the new resolution | — |

### Billing / Bill Run (aggregation + charge computation)

| Component | Change | Item |
|---|---|---|
| Bill-run aggregation/compute (`services/billing/**` + engine `engine-client.ts`/`engine-registry.ts`) | New **usage capacity resolver**: `Qbill = max(Q, committed)` then graduated schedule — the algorithm `plaSpecId` names | PC5, PC6 |
| `db/schema/billing/customer-bill-line.ts` | Grain `(product_offering_id, udr_type)` already has `gross_amount`/`discount_amount`/`net_amount` + `discount_type`/`discount_rate` + `snapshot_*`. Decide the mapping: motivation → `discount_*`; commitment top-up → `gross_amount`. One combined line fits this grain | PC5, O7 |
| `services/billing/partial-period.ts` | Proration of `committedQuantity` | O8 |
| combined-charge rounding | Align with `udr_rounding_mode` / scale-2 `udr_rated_price` | O9 |
| `services/billing/read/list-rated-lines.ts`, `list-uncharged.ts`; `db/repositories/billing/customer-bill-line.repository.ts`, `rated-lines.repository.ts` | Read models + persistence for the new charge shape | — |

### Ordering (override interaction)

| Component | Change | Item |
|---|---|---|
| `db/schema/ordering.ts` (`order_item_price_override`) | **Physical shape unchanged** (PC9); only `once`→`oneTime` if O2 renames the shared `price_type` value | O2 |
| `db/repositories/ordering/order-item-price-override.repository.ts` | Reads unchanged; decide whether an override becomes the base rate the `capacity_*` modifiers compute against | O6 |

### Accounts / BAN & cross-cutting

- **`billing_account` (BAN)** — no structural change; it is the aggregation grain the commitment floor is defined against (O7), and its `currency` drives RL's `CURRENCY_MISMATCH` guard, tied to VI5.
- **TMF620 adapter** (future; external API forbidden now) — envelope → POP + `pricingLogicAlgorithm` + `popRelationship`, and `negotiated_override` → `priceAlteration`.
- **Guardrails/tests** — schema-diff baseline, authz matrix, new component-validation and cross-component tests.
- **Docs** — `ratemgmt-*`, `billmgmt-*` context, and the `plaSpec` doc-block (PC11) as the codebase source of truth.

### Through-line

```
usage_rate ─► RP (rp.py) resolves rate [+rateCard]  ─►  udr_rated (per-UDR, RATED)
                                                          │  aggregate at BAN
capacity_commitment ─┐                                    ▼
capacity_motivation ─┴─► bill-run capacity resolver (PLA) ─► customer_bill_line (one combined charge)
negotiated_override ───► RP base-rate override (O6)
```

---

## Out of scope / touchpoints (later phases)

- **Storage *design* is now in-plan** (see "Product Management — storage & implementation"); only *building* it is later. The physical representation was the O4 decision, now resolved by PC14.
- **`once` → `oneTime` (O2):** touches the `ordering.order_item_price_override.price_type` CHECK plus the TS enum — a schema decision, not a pure JSON change.
- **Base-rate meaning under a varying rate card (O1):** when `rateCardLookUp` yields per-UDR rates, "the base rate" for `capacity_commitment`/`capacity_motivation` is ambiguous (effective/weighted vs `ratePerUnit`). Decide in the bill-run phase.
- **Standardization rollout (O3):** whether retiring the `amount` column + `pricing_model` happens in one migration or phased.
- **The LookUp Rate Card table**, the **bill-run computation**, the **rating extraction logic**, and any **TMF620 adapter** — all separate.

---

## Open items

- **O1** — Base-rate semantics when `rateCardLookUp` varies the per-unit rate across UDRs (effective/weighted vs `ratePerUnit`). Owner: bill-run phase.
- **O2** — `once` → `oneTime` migration (`price_type` CHECK on `product_offering_price` and `ordering.order_item_price_override`, plus the TS enum). Owner: storage phase.
- **O3 — RESOLVED by PC14 + fresh-install:** `amount` and `pricing_model` are dropped in place in `0006_product.sql`; no phased retirement, no backfill.
- **O4 — Physical representation (RESOLVED → PC14, Option A):** reshape the row to `component_type` + `price_component` jsonb, one row per component, `0006_product.sql` edited in place under fresh-install. Alternatives considered and set aside: **B** — a `product_offering_price_component` sidecar for the `capacity_*` modifiers; **C** — a single `pricing_components jsonb[]` column.
- **O5** — Effectivity-aware binding resolution when dated/successor `usage_rate` rows exist for one unit (VI4). Owner: bill-run/resolution phase.
- **O6** — `negotiated_override` × capacity interaction: does an order-item override become the base rate the `capacity_*` modifiers compute against? Extends O1. Owner: bill-run phase.
- **O7** — BAN-level aggregation grain for the commitment floor: per offering, per price ref, or summed across all of the product's subscriptions on the BAN. Owner: bill-run phase.
- **O8** — Proration of `committedQuantity` for a mid-period subscription start/stop or suspension. Owner: bill-run phase.
- **O9** — Rounding policy for the combined charge, aligned with `udr_rounding_mode` and the scale-2 `udr_rated_price`. Owner: bill-run phase.
- **O10** — Not-yet-billable UI warning for the new component types (the pm38 pattern for tiered recurring / tiered usage) until the bill-run phase supports them. Owner: Manage Products UI phase.
