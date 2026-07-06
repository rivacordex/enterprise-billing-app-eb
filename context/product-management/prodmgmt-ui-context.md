# Enterprise Billing App — Product Management Module
## UI Context: Module-Specific Tokens & Rules

> **Inherits the shared brand system from `context/ui-context.md` unchanged** — brand scales, neutrals, base semantic tokens, typography, radius, and elevation are defined there and are not redefined here. This file contains only the semantic wiring of those tokens to Product Management domain objects, plus this module's exclusions. Per code-standards §4.3, define any new variables in `globals.css`; never hardcode hex in a component.

---

## 0. Module Scope & Exclusions

Module-specific semantic wiring below covers: **lifecycle status** (`DRAFT | ACTIVE | RETIRED` → `LifecycleBadge`), **price type** (`recurring | usage | once` → `PriceTypeBadge`), **offering flags** (bundle / sellable / billing-only chips), **spec characteristic chips** (JSONB key–value), **price effectivity states**, and the four-section page surfaces.

Two deliberate exclusions (same rules as User Management):

1. **The AI / Iris-violet family and `--gradient-ai` are NOT used in Product Management v1.** The module is a read-only catalog viewer with no AI/ML components; the AI tokens (ui-context §4) remain reserved. Defining them in `globals.css` is fine; using them here is a scope violation.
2. **Marketing gradients stay off the catalog page.** `/products/product-offering` is a data-dense four-section admin screen — keep it flat. `--gradient-chrome` remains fine in the shared nav/sidebar chrome (unchanged by the "Products" nav section).

---

## 1. Lifecycle Status (`LifecycleBadge`)

**Authoritative mapping for `lifecycle_status`.** Render as a pill (`--radius-pill`), `-bg` tint with `-fg` text, plus icon — same construction as `StatusBadge`:

| `lifecycle_status` | Meaning | Base / icon color | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|---|
| `ACTIVE` | Sellable-eligible; only status billable by later modules | `#1F9D57` success-500 | `#0F5C32` success-700 | `#E6F6EC` success-50 | check-circle |
| `DRAFT` | In definition, not billable | `#E08600` warning-500 | `#8A5200` warning-700 | `#FEF4E6` warning-50 | pencil-line |
| `RETIRED` | Withdrawn; hidden by default behind the status filter | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | archive (render row muted) |

---

## 2. Price Type (`PriceTypeBadge`)

Deliberately calmer than lifecycle status (the auth-method pattern) so price cards don't compete with the section's amounts:

| `price_type` | Meaning | Base | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|---|
| `recurring` | Periodic charge (charge period shown beside) | `#2E45A9` primary-500 | `#1B2A68` primary-700 | `#EDF0FB` primary-50 | repeat |
| `usage` | Metered / consumption (incl. tiered) | `#00899A` cyan-600 | `#006975` cyan-700 | `#E2F8FA` cyan-50 | gauge |
| `once` | One-time charge | `#4C5462` neutral-600 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | zap |

---

## 3. Offering Flags & Spec Chips

**Flag chips** (`is_bundle`, `is_sellable`, billing-only) render only when true — quiet neutral chips (`--radius-xs`, neutral-100 bg, neutral-700 text) with icons `boxes` / `shopping-cart` / `receipt`. Exception: a false `is_sellable` on an `ACTIVE` offering shows a warning-tinted "Not sellable" chip (warning-50 bg / warning-700 text), since that combination is what Billing Ops needs to notice.

**Spec characteristic chips** (`product_spec_characteristics` JSONB, e.g. `SST_ID: 01`, `SD_ID: A0C4E2`): key in `--text-overline` neutral-500, value in `--text-mono` neutral-800, on `--surface-sunken` with `--radius-xs`. Mandatory/default indicators on spec cards reuse info-50/info-700 (`Mandatory`) and neutral-100/neutral-700 (`Default: …`) tints.

---

## 4. Price Effectivity States

A price's end is derived from its successor's `start_date_time`; cards signal temporal state without new hues:

| State | Rule | Treatment |
|---|---|---|
| Current | effective now | Default card; left border `#00A9BC` cyan-500 (connectivity = "live") |
| Future-dated | `start_date_time` in future | info-50 bg tag "Starts <date>" in info-700; default card otherwise |
| Superseded | successor already started | Card muted (`--text-muted`), tag "Superseded" neutral-100/neutral-700 |

Tiered prices render the tier mini-table (`from / to / rate`) flat with `--radius-none`, `--text-body-sm`, header row in `--text-overline`.

---

## 5. Module Typography & Surface Notes

Use `--font-mono` for the sequence IDs (`PRDOFR…`, `PRDSMD…`, `PRDOFP…`), GL codes, SST/SD values, and `version`; enable `tabular-nums` on amounts, tier bounds/rates, and the version column. Amounts render `--text-h4` weight 600 with currency code in `--text-caption` muted. Selected offering row uses the shared `--surface-selected`; sections 2–4 are `--surface-card` on `--surface-app` with `--border-default`. There is no featured CTA in read-only v1 — `--action-cta-bg` is reserved for the CRUD fast-follow (e.g. "New offering").

---

## 6. Module Usage Notes

- **Badges (§1–2)** render dark `-fg` text on the light `-bg` tint — never white-on-tint — and always pair icon + label so meaning never depends on color alone (`RETIRED` vs `once` vs superseded are all grayish by design; icons disambiguate).
- Empty panel states ("Select an offering", no specs/prices) use `--text-muted` on `--surface-sunken`; no gradients.
