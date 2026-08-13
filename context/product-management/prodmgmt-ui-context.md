# Enterprise Billing App — Product Management Module
## UI Context: Module-Specific Tokens & Rules

> **Inherits the shared brand system from `context/ui-context.md` unchanged** — brand scales, neutrals, base semantic tokens, typography, radius, and elevation are defined there and are not redefined here. This file contains only the semantic wiring of those tokens to Product Management domain objects, plus this module's exclusions. Per code-standards §4.3, define any new variables in `globals.css`; never hardcode hex in a component. Covers both View Product (read-only) and Manage Products (CRUD).

---

## 0. Module Scope & Exclusions

Module-specific semantic wiring below covers: **lifecycle status** (`DRAFT | ACTIVE | RETIRED` → `LifecycleBadge`), **price type** (`recurring | usage | once` → `PriceTypeBadge`), **offering flags** (bundle / sellable / billing-only chips), **spec/tier JSONB entries** (rendered as plain text), **price effectivity states**, the four-section View Product page surfaces, and the Manage Products table/dialogs/forms.

> **Scope note:** the planned **Product Ordering & Inventory update** (Orders/Subscriptions pages) is wired here — pm27 (§8) wires the Orders list: `OrderStatusBadge` (TMF622 order states) and the negotiated-price indicator; pm31 wires the manager review-screen treatment (reuses §8's tokens, no new ones). pm33 (§9) wires the Subscriptions page: `SubscriptionStatusBadge` (TMF637 subscription states) and the status-history sub-row treatment. `mockup-product-ordering.html` (referenced in the planning docs) is not present in this repo — pm33 follows the Manage Products family-expand affordance (§7) as the closest in-repo precedent for the status-history sub-rows instead.

Two deliberate exclusions (same rules as User Management), applying to **both** product pages:

1. **The AI / Iris-violet family and `--gradient-ai` are NOT used anywhere in Product Management.** Neither page has AI/ML components; the AI tokens (ui-context §4) remain reserved. Defining them in `globals.css` is fine; using them here is a scope violation.
2. **Marketing gradients stay off both product pages.** `/products/product-offering` and `/products/manage-products` are data-dense admin screens — keep them flat. `--gradient-chrome` remains fine in the shared nav/sidebar chrome (unchanged by the "Products" nav section).

---

## 1. Lifecycle Status (`LifecycleBadge`)

**Authoritative mapping for `lifecycle_status`.** Render as a pill (`--radius-pill`), `-bg` tint with `-fg` text, plus icon — same construction as `StatusBadge`. Used identically on both View Product and Manage Products rows:

| `lifecycle_status` | Meaning | Base / icon color | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|---|
| `ACTIVE` | Sellable-eligible; the only status billable by later modules, and at most one version per product family may hold it | `#1F9D57` success-500 | `#0F5C32` success-700 | `#E6F6EC` success-50 | check-circle |
| `DRAFT` | In definition, not billable | `#E08600` warning-500 | `#8A5200` warning-700 | `#FEF4E6` warning-50 | pencil-line |
| `RETIRED` | Withdrawn; hidden by default behind the status filter on View Product; on Manage Products, shows no row actions | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | archive (render row muted) |

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

**Flag chips** (`is_bundle`, `is_sellable`, billing-only) render only when true — quiet neutral chips (`--radius-xs`, neutral-100 bg, neutral-700 text) with icons `boxes` / `shopping-cart` / `receipt`. Exception: a false `is_sellable` on an `ACTIVE` offering shows a warning-tinted "Not sellable" chip (warning-50 bg / warning-700 text), since that combination is what Billing Ops needs to notice. `is_bundle` keeps this exact treatment everywhere it's displayed, including on Manage Products; `OfferingForm` never renders an input for it, in create or edit mode — the chip is genuinely display-only, not just "unbuilt."

**Spec characteristics** (`product_spec_characteristics` JSONB, e.g. `SST_ID: 01`, `SD_ID: A0C4E2`) render as plain inline text — no chip/pill treatment (revised 2026-07-09 — density pass): key in muted text, value in `--text-mono` inline. Mandatory/default indicators on spec cards reuse info-50/info-700 (`Mandatory`) and neutral-100/neutral-700 (`Default: …`) tints.

---

## 4. Price Effectivity States

A price's end is derived from its successor's `start_date_time`; cards signal temporal state without new hues:

| State | Rule | Treatment |
|---|---|---|
| Current | effective now | Default card; left border `#00A9BC` cyan-500 (connectivity = "live") |
| Future-dated | `start_date_time` in future | info-50 bg tag "Starts <date>" in info-700; default card otherwise |
| Superseded | successor already started | Card muted (`--text-muted`), tag "Superseded" neutral-100/neutral-700 |

Tiered prices render each tier's `from`/`to`/`rate` as plain inline text (e.g. `0–1000: 0.05`), semicolon-separated — no table (revised 2026-07-09 — density pass).

---

## 5. Module Typography & Surface Notes

Use `--font-mono` for the sequence IDs (`PRDOFR…`, `PRDSMD…`, `PRDOFP…`), GL codes, SST/SD values, and `version`; enable `tabular-nums` on amounts, tier bounds/rates, and the version column — identical on Manage Products' table. Amounts render `--text-h4` weight 600 with currency code in `--text-caption` muted. Selected offering row uses the shared `--surface-selected`; View Product's sections 2–4 are `--surface-card` on `--surface-app` with `--border-default`.

`--action-cta-bg` is used exactly once across the module: the "New offering" button in the Manage Products page header. It remains the **only** accent-filled primary action on that page (per the shared design system's "one accent button per view" rule) — every other action (Edit, Add price, Activate) uses the quieter secondary/ghost treatment; only Retire/Discard use the danger role, and only inside their confirmation dialogs. (The Activate-confirmation dialog's own "Activate" button is the one other place an accent button appears — acceptable since it never renders in the same view as the page-header CTA.)

---

## 6. Module Usage Notes

- **Badges (§1–2)** render dark `-fg` text on the light `-bg` tint — never white-on-tint — and always pair icon + label so meaning never depends on color alone (`RETIRED` vs `once` vs superseded are all grayish by design; icons disambiguate). This applies to every row-action icon button on Manage Products too.
- Empty panel states ("Select an offering", no specs/prices, "no versions beyond this one") use `--text-muted` on `--surface-sunken`; no gradients. A family with only one version shows no expand chevron at all, rather than an expand control that reveals nothing.

---

## 7. Manage Products — Component Wiring

Patterns that exist only on the CRUD page — View Product never needed them.

**Row action buttons.** Icon-only, 28px square, `0.5px solid var(--border)`, following the icon+`aria-label` rule (§6):

| Action | Icon | Color role | Shown on |
|---|---|---|---|
| Edit | `edit` | `--text-secondary` (quiet) | `DRAFT`, `ACTIVE` |
| Add price | `cash` | `--text-secondary` (quiet) | `DRAFT`, `ACTIVE` |
| Activate | `check` | `--text-secondary` (quiet — not accent; the CTA stays reserved for "New offering") | `DRAFT` only |
| Discard | `trash` | `--text-danger` | `DRAFT` only |
| Retire | `archive` | `--text-danger` | `ACTIVE` only |
| Specifications | `list-checks` | `--text-secondary` (quiet) | `DRAFT`, `ACTIVE` |
| — | — | — | `RETIRED` rows show no action buttons — muted row, replaced with plain `--text-muted` text, "No actions — retired." |

**"This creates a new draft" warning.** Shown inside the Edit dialog and the Add Price dialog whenever the target offering's current status is `ACTIVE` (never on a `DRAFT` target). Treatment: `--bg-warning` background, `--text-warning` text, `--radius` corners, no icon needed (the copy itself is the signal) — same tint pairing as the `DRAFT` lifecycle badge (§1). Copy pattern: *"`<Name>` is active. Saving will not change it — a new draft version is created instead."*

**Backdating warning.** Shown inside the Add Price form when the chosen start date is in the past but within the 3-day tolerance. Same `--bg-warning`/`--text-warning` treatment as above. Copy pattern: *"This price is backdated to `<date>`; historical bills may be affected."* A start date beyond the tolerance is a validation error (standard `FieldError` red-text treatment, not this banner), not a warning.

**Discard vs. Retire dialog.** One component (`RetireOfferingDialog`), two copy states selected by the target's current status — both use the shared `AlertDialog` danger pattern (`alert-triangle` icon in `--text-danger`, danger-role confirm button):

| Status at time of action | Title | Body copy pattern | Confirm button |
|---|---|---|---|
| `DRAFT` | "Discard draft" | *"Discarding `<Name>` removes this draft — it never went live and this cannot be undone."* | "Discard draft" |
| `ACTIVE` | "Retire offering" | *"Retiring `<Name>` hides it from new billing selection. This cannot be undone."* | "Retire offering" |

Both include an optional "Reason" text input — a plain, unlabeled-as-required text field, `FieldLabel` reads "Reason (optional)", placeholder gives a realistic example rather than "e.g." boilerplate.

**Version-family grouping.** The Manage Products table shows one row per family by default (its `ACTIVE` version, or latest `DRAFT` if never active). A chevron-style expand affordance (`chevron-down`/`chevron-right`, `--text-muted`, rotates on expand — same interaction convention as any other disclosure control in the app) reveals the family's other versions as indented sub-rows beneath the primary row, each with its own status badge and its own row actions per the table above. Non-primary rows use a subtly recessed background (`--surface-sunken`, the same token used by empty-panel states) to visually subordinate them to the family's primary row without introducing a new surface token.

**Activate confirmation.** Not a danger dialog (activation isn't destructive) — a plain confirmation dialog, default button styling for "Cancel," accent-filled for "Activate" (the one place besides "New offering" where an accent button appears — acceptable since they never render in the same view). Body copy states the precondition plainly and, when relevant, that activating will retire the family's current active version automatically: *"`<Name>` will become billable once activated. Requires at least one price and all mandatory specs resolved. If another version of this product is currently active, it will be retired automatically."* Includes the same optional "Reason" field as the Discard/Retire dialog.

---

## 8. Ordering — Orders Page (pm27)

Patterns for `/products/orders`. `--action-cta-bg` is used exactly once on this page too ("New order," same one-accent-button-per-view rule as Manage Products' "New offering" — the two pages never render together, so no conflict).

**`OrderStatusBadge` (TMF622 order status).** Same pill construction as `LifecycleBadge`/`PriceTypeBadge` (§1/§2 — dark `-fg` text on light `-bg` tint, icon + label, never color-only). All nine seeded `ORDER_STATUSES` get a variant; the phase only ever writes `ACKNOWLEDGED`/`PENDING`/`COMPLETED`/`REJECTED`/`FAILED` (architecture §3), so the remaining four (`HELD`/`IN_PROGRESS`/`CANCELLED`/`PARTIAL`) render if the full enum is ever exercised but are otherwise unused:

| `status` | Meaning | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|
| `COMPLETED` | Order fulfilled; inventory instantiated | `--color-success-700` | `--color-success-50` | check-circle |
| `PENDING` | Awaiting manager review (has a negotiated price) | `--color-warning-700` | `--color-warning-50` | clock |
| `REJECTED` | Manager declined; terminal, no inventory | `--color-danger-700` | `--color-danger-50` | x-circle |
| `FAILED` | Completion attempt failed | `--color-danger-700` | `--color-danger-50` | alert-triangle |
| `ACKNOWLEDGED` | Order received and acknowledged (a standard, no-override order's initial state before auto-completion) | `--color-neutral-700` | `--color-neutral-100` | file-check |
| `HELD` / `IN_PROGRESS` / `CANCELLED` / `PARTIAL` | In-flight or terminal states not yet written by this phase | `--color-neutral-700` | `--color-neutral-100` | status-specific, distinct per state |

**Negotiated-price indicator.** Renders in the Orders table's Price column on `hasOverride` rows — **not** the AI/Iris-violet family (§0 exclusion still applies in full to this page). Uses the shared **Accent** scale instead (ui-context §1.2 — the brand's own "magenta → violet" energy accent, distinct from the reserved AI tokens): a pill, `--color-accent-50` bg / `--color-accent-700` text, a `handshake` icon, label "Negotiated." A row with no override renders plain muted text, lowercase "list" (not a pill — the absence of a negotiated price isn't a status worth badging).

**Review affordance.** A small quiet button next to the status badge on `PENDING` rows only ("Review"), `--text-secondary`/`text-muted-foreground` treatment matching Manage Products' quiet row actions (§7). Inert in pm27 (seam for pm31); stops click propagation so it never triggers the row's own `?order=` selection.

**"New order" CTA.** Header button, `--action-cta-bg`, same treatment as "New offering." Inert in pm27 (seam for pm29).

**Reviewed column.** `— (auto)` in muted text for a standard (no-override) order that reached `COMPLETED` without a human reviewer — distinct from a plain `—` (unreviewed, still in flight) so the two "nothing to show" cases stay visually distinguishable via text alone (no color coding needed for a muted informational column).

---

## 9. Ordering — Subscriptions Page (pm33)

Patterns for `/products/subscriptions`. No `--action-cta-bg` on this page — subscriptions are created only via a completed order (Orders page), never directly, so there is no "New" CTA to reserve it for.

**`SubscriptionStatusBadge` (TMF637 subscription status).** Same pill construction as `LifecycleBadge`/`PriceTypeBadge`/`OrderStatusBadge` (§1/§2/§8). All eight seeded `PRODUCT_STATUSES` get a variant; the phase only ever writes `ACTIVE`/`SUSPENDED`/`TERMINATED` (architecture §3), so the remaining five render if the full enum is ever exercised but are otherwise unused:

| `status` | Meaning | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|
| `ACTIVE` | Billable now | `--color-success-700` | `--color-success-50` | check-circle |
| `SUSPENDED` | Temporarily held; excluded from rating for the open window | `--color-warning-700` | `--color-warning-50` | pause-circle |
| `TERMINATED` | Ended, terminal — reuses the catalog's `RETIRED`-row convention (§1: archive icon, row muted, no actions) | `--color-neutral-700` | `--color-neutral-100` | archive |
| `CREATED` / `PENDING_ACTIVE` / `PENDING_TERMINATE` / `CANCELLED` / `ABORTED` | Not yet written by this phase | `--color-neutral-700` | `--color-neutral-100` | status-specific, distinct per state |

**Status-history sub-rows.** Row expand reuses the Manage Products family-expand affordance (§7 "Version-family grouping" — chevron rotates on expand, `--surface-sunken` recessed background) rather than a new disclosure pattern: clicking a row's chevron reveals its append-only transition log (architecture Inv. #18) as indented sub-rows beneath it, each showing from → to status (as `SubscriptionStatusBadge` pairs), effective date, reason, and actor. A derived suspension-window note renders beneath the transition table when the instance has one or more: *"Suspended `<from>` → `<to or 'ongoing'>` — excluded from rating."* Only one subscription row is expanded at a time (URL-driven, `?subscription=`), matching View Product's single-selection deep-link convention (code-standards §3.5) rather than Manage Products' independent per-family toggle state.

**Negotiated-price indicator.** Same treatment as the Orders table (§8) — a `hasOverride` row shows the Accent-scale "Negotiated" pill (`handshake` icon) in the Offer column; a row with no override renders plain muted "list" text.

**Row actions.** Icon-only, 28px square, `0.5px solid var(--border)` — the same construction as Manage Products' row actions (§7), quiet role except Terminate:

| Action | Icon | Color role | Shown on |
|---|---|---|---|
| Suspend | `pause-circle` | `--text-secondary` (quiet) | `ACTIVE` only |
| Resume | `play-circle` | `--text-secondary` (quiet) | `SUSPENDED` only |
| Terminate | `x-circle` | `--text-danger` | `ACTIVE`, `SUSPENDED` |
| Edit characteristics | `pencil` | `--text-secondary` (quiet) | any non-`TERMINATED` status |
| — | — | — | `TERMINATED` rows show no action buttons — muted row, replaced with plain `--text-muted` text, "No actions — terminated" (the catalog's RETIRED-row convention, §1/§7). |

**Backdating warning/error.** Suspend/resume/terminate's effective-date field reuses the catalog's exact backdating banner treatment (§7 "Backdating warning" — `--bg-warning`/`--text-warning`, no icon) for a date within the 3-day tolerance, and the standard `FieldError` red-text treatment beyond it — same split Add Price's start-date field uses, applied here to `effective_date`/`end_date` (architecture Inv. #21/Q19).

**Terminate confirmation.** A danger `AlertDialog` (`alert-triangle` icon in `--text-danger`, danger-role confirm button — the Discard/Retire dialog's construction, §7), since termination is destructive and irreversible. Copy pattern: *"Terminating ends billing after `<end date>`. This cannot be undone."* Suspend and Resume are plain (non-danger) confirmation dialogs — reversible lifecycle moves, not terminal ones.

**Edit characteristics.** Reuses the Ordering wizard's `CharacteristicsEditor` (§8's sibling component, `components/products/ordering/characteristics-editor.tsx`) unmodified against `instance_characteristics`. Body copy states plainly that the edit never affects pricing: characteristics are descriptive only and are never a rating input (architecture §3, `instance_characteristics` row).
