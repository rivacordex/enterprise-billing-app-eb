# pm53 — Component rendering: badge + View Product's prices panel

**Unit:** pm53 (Part 4). **Boundary:** `components/products/pricing-component-badge.tsx` (new), `components/products/price-type-badge.tsx` (deleted), `components/products/prices-panel.tsx`, `components/products/price-effectivity.tsx`, and their tests. **View Product's files — read-only rendering only.** No authoring, no action import, no write service, no schema, no repository.
**Specs from:** `prodmgmt-ui-context.md` §2, §4, §5, §6 · `prodmgmt-code-standards.md` §2.6, §2.18, §4.1, §4.2, §4.5, §4.15, §4.18, §4.21, §7.3, guardrail 11, Appendix A row **A7** · `prodmgmt-architecture.md` §3.3, Inv. #29, #30, #39, #42 · `prodmgmt-ai-workflow-rules.md` §6.4 (the named trap), §7.1.
**Depends on:** **pm49** (the `PriceCard` carrying `componentType`, the parsed `component` and per-lane effectivity).

**Why this is its own unit.** `prices-panel.tsx` belongs to **View Product**, not Manage Products, and workflow §6.4 names it the trap in this update: it renders the dropped shape and needs a change it cannot absorb read-only. Folding it into the authoring UI would put a View Product edit inside a Manage Products diff — exactly what Inv. #29 and guardrail 11 exist to prevent. It is also the natural cut: rendering has its own visible result, and pm54's editable panel imports what this unit produces.

---

## Goal

Render pricing components read-only on View Product: a total per-`component_type` badge replacing `PriceTypeBadge`, step schedules and committed quantities as plain inline text, `rateCardLookUp` as an unresolvable name, and Current / Future-dated / Superseded computed per `(component_type, unit_of_measure)` lane — so pm48's four-component demo offering reads correctly under `products : READ`.

---

## Design

### D1. `PricingComponentBadge` is one total `Record<ComponentType, …>` with one two-variant type

Per ui-context §2, five rendered variants over **four** component types:

| `component_type` | Envelope `priceType` | Label | Icon | Tint |
| --- | --- | --- | --- | --- |
| `usage_rate` | `usage` | Usage rate | `gauge` | cyan-50 / cyan-700 |
| `flat_fee` | `recurring` | Recurring charge | `repeat` | primary-50 / primary-700 |
| `flat_fee` | `oneTime` | One-time charge | `zap` | neutral-100 / neutral-700 |
| `capacity_commitment` | `commitment` | Target capacity commitment | `arrow-down-to-line` | info-50 / info-700 |
| `capacity_motivation` | `discount` | Target capacity motivation | `trending-down` | accent-50 / accent-700 |

The map is keyed by `ComponentType` and is **total**, so a new type is a compile error, never a default branch (§2.2, §4.18). `flat_fee` is the one type with two variants, and **its label and hue come from `price_component.priceType` — never from the charge-period columns**: a `flat_fee` with no period is `oneTime`, not a broken recurring price.

Icon + label always; never colour-only meaning; dark `-fg` text on the light `-bg` tint, never white-on-tint (§6).

`negotiated_override` gets **no badge here** (Inv. #39) — it is not a catalog component, is not persistable in this table, and is already wired as the Orders/Subscriptions "Negotiated" pill. The record covers four types; state that in a comment beside the map so its arity is not read as an omission.

### D2. The badge reads the column, not the JSON — with one exception it must state

`component_type` always equals `price_component ->> '@type'` (Inv. #30), so the badge switches on the **column**. The single envelope field it reads is `priceType`, for the `flat_fee` split. A row whose column and envelope disagree is corruption, not a variant: **render nothing rather than guessing** (ui-context §2). Since pm46's CHECK and pm49's write-by-construction make that unreachable, the branch is a guard, not a fallback — comment it as such so it is not "simplified away".

### D3. `PriceTypeBadge` is retired, not adapted

Delete `components/products/price-type-badge.tsx` and its test. Every call site moves to `PricingComponentBadge`. No alias, no re-export, no `legacyPriceType` prop. Guardrail 31's grep sweep covers the residue.

### D4. Amount rendering is keyed to `component_type`, and the row owns unit and period

Per ui-context §5:

- `usage_rate` → `ratePerUnit / unit` — `RM 0.05 / GB`
- `flat_fee` `recurring` → `amount / period` — `RM 5,000.00 / month`
- `flat_fee` `oneTime` → the bare `amount`, **no unit** (`unit_of_measure` is NULL on every `flat_fee` row)
- `capacity_commitment` → `committed 1,000 EA` — quantity and unit only, **no currency**, because the component carries no money
- `capacity_motivation` → the step text of D5

Money goes through `formatCurrency(amount, currency, locale)` with the **row's** `currency`. The envelope's money is a **decimal string**: format it, never re-parse it to a different precision and never convert it to a number on the way to the formatter (§4.5). Unit and period come from the row's columns, never from `params` and never inferred; the unit keeps its stored casing exactly (`Mbps`, never `MBPS`). `tabular-nums` on amounts, step thresholds and rates, committed quantities, charge-period lengths and version numbers.

### D5. `steps` render as ascending inline text — no table, no widget

`base 100; above 1000: 50; above 2000: 25` — semicolon-separated, ascending, plain text (ui-context §2, §4). The leading `base <rate>` comes from the **same-unit `usage_rate` on the offering** when one is present, because the schedule is meaningless without it; when none is present, render the steps alone and let pm54's blocking banner be the thing that says why (this panel is read-only and never diagnoses).

No `TierTable`, no `StepTable`, no `CharacteristicChip`. This inherits the density rule the dropped tiered rendering established.

### D6. `rateCardLookUp` renders as a name, never as a reference

`--font-mono`, beside the rate, with a muted **"default rate"** when null (§4.15, ui-context §4/§5). **No link, no lookup affordance, no autocomplete, no "view rate card" action, and no query** — the table it names does not exist (Inv. #42, §1.27). Anything implying resolvability is a defect, not a nicety.

### D7. Effectivity is per lane, and that is visible

Current / Future-dated / Superseded are computed per `(component_type, unit_of_measure)` lane from pm49's `endDateTime`/`effectivityStatus` — **the panel computes nothing itself**. Treatments unchanged (ui-context §4): Current keeps the cyan-500 left border as a functional live marker; Future-dated takes the info-50 "Starts `<date>`" tag; Superseded is muted with a neutral "Superseded" tag.

The visible consequence, and pm53's sharpest assertion: **a `capacity_motivation` no longer supersedes the `usage_rate` beside it.** Test it with the demo offering plus a dated successor.

### D8. Derived envelope fields are never surfaced

Raw `@type` / `component_type` values, `specVersion`, `plaSpecId`, `appliesAt`, `basis` and `boundTo` appear in **no** user-facing string, label, tooltip, `title` attribute, `aria-label` or table cell (§4.21, ui-context §5). The badge label is the user-facing name of a component type. A test greps the rendered output for the four literal type strings and the five derived field names.

### D9. The envelope is `import type`-only here

`prices-panel.tsx` and the badge import `PricingComponent` / `ComponentType` as **types**, never `pricingComponentSchema` (§2.18). A component does not re-parse data a service already parsed. If a render needs a narrowing, narrow on `componentType` (the discriminator) — do not call `.parse()` in a component.

### D10. Read-only stays read-only, and the import direction stays one-way

No `actions/product/**` import, no write service, no `'use client'` added to the panel, no editing affordance. `components/products/manage/**` may import these files; these files import nothing from `manage/` (Inv. #29, guardrail 11). Guardrail 11 runs here and must stay green with its converse assertion still dropped.

---

## Implementation

### I1. `components/products/pricing-component-badge.tsx` (new)

`PricingComponentBadge({ componentType, priceType })` — exactly the name code-standards §4.8 binds. One total `Record<ComponentType, …>`; the `flat_fee` entry resolves its variant from `priceType` (D1); tokens by name from ui-context §2, never duplicated as literals in this file beyond the token references the design system exposes. Renders icon + label. No accent-filled action treatment (§4.9).

### I2. `components/products/prices-panel.tsx`

1. Replace `PriceTypeBadge` with `PricingComponentBadge`.
2. Branch the value rendering on `componentType` through a **total** map (D4) — no `switch` without an exhaustive `never` default (§2.2).
3. Add the step-text renderer (D5) and the committed-quantity renderer (`committed 1,000 EA`, no currency).
4. Add the `rateCardLookUp` name / "default rate" rendering (D6).
5. Keep the section's layout, empty state, ordering and the four-section grid as they are — this unit changes what a price card says, not where it sits.
6. Delete every reference to `amount`, `pricingModel`, `priceType` (the column) and tiered rendering.

### I3. `components/products/price-effectivity.tsx`

Re-key to per-lane input (D7). It consumes `effectivityStatus`/`endDateTime` from the read model; if it currently derives anything from `priceType`, remove that — the lane is the repository's business now.

### I4. Deletions

`components/products/price-type-badge.tsx` and its test; any tiered-rendering helper still in this folder.

### I5. Tests

1. **`tests/components/pricing-component-badge.test.tsx` (new).** All five variants render with the right label and icon; `flat_fee` switches on the envelope `priceType` and **not** on the presence of a charge period (assert a `recurring` `flat_fee` with no period renders as one-time, and that a `oneTime` one is never labelled recurring because a period exists); the map is total (a type-level assertion that adding a `ComponentType` breaks the build).
2. **`tests/components/prices-panel.test.tsx` (updated).** Renders pm48's four-component demo offering: `RM 100.00 / EA`; `committed 1,000 EA` with no currency symbol anywhere in that card; `base 100; above 1000: 50; above 2000: 25`; the `rateCardLookUp` name in mono; `RM 2,000.00 / month`.
3. **Per-lane effectivity (D7).** With a dated successor `usage_rate` and a `capacity_motivation`: the superseded `usage_rate` is muted and tagged, the successor is Current, and the `capacity_motivation` is **Current, not Superseded**.
4. **Null rate card** renders the muted "default rate" and no link, no button, no `href`.
5. **D8 leak test.** The rendered markup contains none of `usage_rate`, `flat_fee`, `capacity_commitment`, `capacity_motivation`, `specVersion`, `plaSpecId`, `appliesAt`, `basis`, `boundTo` — in text, `title` or `aria-label`.
6. **D2 guard.** A card whose `componentType` disagrees with its envelope `@type` renders nothing rather than a guessed badge.
7. **Guardrail 11** green: View Product imports nothing from `actions/product/`, `components/products/manage/` or a write service.
8. **Authz:** the panel renders under `products : READ`; no write affordance appears at any level.

### I6. Documentation

1. `prodmgmt-code-standards.md` §7 file tree — add `pricing-component-badge.tsx`, remove `price-type-badge.tsx`, and **correct the stale unit markers**: `prices-panel.tsx` and the badge are pm53 (not pm50); the picker and banner are pm54 (not pm51); the steps editor is pm55 (not pm52). Record the correction per workflow §7.10.
2. `prodmgmt-code-standards.md` Appendix A row **A7** — guardrail 27's re-key to `component_type` is asserted at pm56; leave A7 open here and note pm53 delivered the rendering half.
3. `prodmgmt-ui-context.md` §2, §4, §5 — the rekeyed text already describes this unit's behaviour; confirm it matches what shipped and correct any divergence found, in the same change set (workflow §7.1).

---

## Dependencies

**Packages to install: none.** Existing UI primitives, the shared badge pattern, `lucide` icons already in `components/nav-icons.ts` / the shared icon set (`gauge`, `repeat`, `zap`, `arrow-down-to-line`, `trending-down` — verify each is already imported somewhere in the app before adding an icon dependency), `formatCurrency`, `formatDatetime`, `vitest` + Testing Library.

**Commands used:** `npm run test`, `npx tsc --noEmit`, `npm run lint`, and a local run of View Product against the pm48 demo seed.

---

## Verification checklist

Rendering

- [ ] View Product's Prices section renders pm48's four-component demo offering read-only under `products : READ`.
- [ ] Badges: usage rate, recurring charge, one-time charge, commitment, motivation — icon + label, correct tints, no colour-only meaning.
- [ ] `flat_fee`'s variant comes from the envelope `priceType`, never from the charge-period columns — both directions tested.
- [ ] `usage_rate` renders `amount / unit`; `recurring` `flat_fee` renders `amount / period`; `oneTime` renders a bare amount with no unit.
- [ ] `capacity_commitment` renders `committed 1,000 EA` with **no currency**.
- [ ] `capacity_motivation` renders ascending semicolon-separated step text, with the base rate from the same-unit `usage_rate` when present.
- [ ] `rateCardLookUp` renders in `--font-mono`; null renders a muted "default rate"; neither is a link and neither triggers a query.
- [ ] `tabular-nums` on amounts, thresholds, rates, committed quantities and period lengths; the unit keeps its stored casing.

Effectivity

- [ ] Current / Future-dated / Superseded are computed **per lane** and taken from the read model, not derived in the panel.
- [ ] A `capacity_motivation` does not supersede the `usage_rate` beside it; a dated `usage_rate` successor still supersedes its predecessor.

Boundaries

- [ ] `PriceTypeBadge` is deleted with its test; no alias or re-export survives.
- [ ] No raw `@type` / `component_type` value and none of `specVersion`, `plaSpecId`, `appliesAt`, `basis`, `boundTo` appear in any user-facing string.
- [ ] The envelope is imported type-only; no component calls `.parse()`.
- [ ] No `actions/product/**`, write service or `manage/**` import; no `'use client'` added; guardrail 11 green.
- [ ] `negotiated_override` has no badge and no rendering path.
- [ ] `tsc --noEmit`, ESLint and Prettier clean for this unit's files; repo-wide green remains pm54's claim (G-E).

Documentation

- [ ] Code-standards §7 file tree updated **and** its stale pm50/pm51/pm52 markers corrected to pm53/pm54/pm55.
- [ ] ui-context §2/§4/§5 confirmed to match what shipped.

**Definition of done:** a Billing Ops user with read access opens View Product and sees, in plain language, that the plan charges 100 per EA, commits the customer to 1,000 EA, discounts to 50 above 1,000 and 25 above 2,000, and bills 2,000.00 a month — with the commitment showing no currency it does not have, the rate card showing as a name that goes nowhere, and each component ageing in its own lane.
