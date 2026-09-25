# Enterprise Billing App — Product Management Module
## UI Context: Module-Specific Tokens & Rules

> **Inherits the shared brand system from `context/ui-context.md` unchanged** — brand scales, neutrals, base semantic tokens, typography, radius, and elevation are defined there and are not redefined here. This file contains only the semantic wiring of those tokens to Product Management domain objects, plus this module's exclusions. Per code-standards §4.3, define any new variables in `globals.css`; never hardcode hex in a component. Covers both View Product (read-only) and Manage Products (CRUD). The **pricing-components update** (`_updatemodule-product-pricing-components-plan.md`, `prodmgmt-update-overview.md`) adds **no new color, typography, radius or elevation token** either — it rekeys the existing wiring (§2, §4, §5, §7) from the dropped `price_type` column onto `component_type`, and every hue it needs already exists in the shared file. The **rate card lookup update** (`_updatemodule-ratecard-lookup-plan-v2.md`, `prodmgmt-update-overview.md`, `prodmgmt-architecture.md`) adds **no new color, typography, radius or elevation token either** — the whole `/products/rate-card` surface (§10) is assembled from shared hues. It adds §10 and changes nothing else already written here: `rateCardLookUp` stays a validated **name only** (no referent — Inv. #42 unamended) and `service_code` is not added to `product_offering_price`. This delivery stands up the `RATECARD_RAN_USAGE_LKP` table and its read/write surfaces; the rating consumer is a following-sprint deliverable.

---

## 0. Module Scope & Exclusions

Module-specific semantic wiring below covers: **lifecycle status** (`DRAFT | TESTING | ACTIVE | OBSOLETE | RETIRED` → `LifecycleBadge`), **pricing component type** (`usage_rate | flat_fee | capacity_commitment | capacity_motivation` → `PricingComponentBadge`, which replaces `PriceTypeBadge` once `price_type` is dropped — §2), **offering flags** (bundle / sellable / billing-only chips), **spec JSONB entries and `capacity_motivation.steps`** (rendered as plain text), **price effectivity states**, the four-section View Product page surfaces, the Manage Products table/dialogs/forms, and — rate card update — the **Rate Card version lifecycle, upload, row-preview and diff surfaces** (§10).

> **Scope note:** the planned **Product Ordering & Inventory update** (Orders/Subscriptions pages) is wired here — pm27 (§8) wires the Orders list: `OrderStatusBadge` (TMF622 order states) and the negotiated-price indicator; pm31 wires the manager review-screen treatment (reuses §8's tokens, no new ones). pm33 (§9) wires the Subscriptions page: `SubscriptionStatusBadge` (TMF637 subscription states) and the status-history sub-row treatment. `mockup-product-ordering.html` (referenced in the planning docs) is not present in this repo — pm33 follows the Manage Products family-expand affordance (§7) as the closest in-repo precedent for the status-history sub-rows instead.

Two deliberate exclusions (same rules as User Management), applying to **both** product pages:

1. **The AI / Iris-violet family and `--gradient-ai` are NOT used anywhere in Product Management.** Neither page has AI/ML components; the AI tokens (ui-context §4) remain reserved. Defining them in `globals.css` is fine; using them here is a scope violation.
2. **Marketing gradients stay off every product page.** `/products/product-offering`, `/products/manage-products` and `/products/rate-card` are data-dense admin screens — keep them flat. `--gradient-chrome` remains fine in the shared nav/sidebar chrome (unchanged by the "Products" nav section).

---

## 1. Lifecycle Status (`LifecycleBadge`)

**Authoritative mapping for `lifecycle_status`.** Render as a pill (`--radius-pill`), `-bg` tint with `-fg` text, plus icon — same construction as `StatusBadge`. Used identically on both View Product and Manage Products rows. The five variants come from one total `Record<LifecycleStatus, …>`, so a new status is a compile error, never a default branch:

| `lifecycle_status` | Meaning | Base / icon color | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|---|
| `DRAFT` | In definition, editable, not billable | `#E08600` warning-500 | `#8A5200` warning-700 | `#FEF4E6` warning-50 | pencil-line |
| `TESTING` | Released for testing; content read-only; not orderable, not billable; reversible to `DRAFT` | `#1A73D9` info-500 | `#0C4084` info-700 | `#E7F1FD` info-50 | flask-conical |
| `ACTIVE` | The only orderable status; at most one version per family may hold it | `#1F9D57` success-500 | `#0F5C32` success-700 | `#E6F6EC` success-50 | check-circle |
| `OBSOLETE` | Superseded or withdrawn from sale; **still billed** for existing subscriptions; only action is Retire | `#4C5462` neutral-600 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | history (render row muted) |
| `RETIRED` | No live subscription remains; terminal. Hidden by default behind the status filter on View Product; shows no actions | `#6A7283` neutral-500 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | archive (render row muted) |

---

## 2. Pricing Component Type (`PricingComponentBadge`)

**Pricing-components update — this badge rekeys from `price_type` to `component_type` (PC14).** The `price_type` column is dropped, so the three old variants map **forward onto the new discriminator without a new hue**; the badge stays deliberately calmer than lifecycle status (the auth-method pattern) so price cards don't compete with the section's amounts. One total `Record<ComponentType, …>`, so a new component type is a compile error, never a default branch:

| `component_type` | Envelope `priceType` | Meaning | Base | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|---|---|
| `usage_rate` | `usage` | Base per-unit rate feeding rating (was `price_type = 'usage'`) | `#00899A` cyan-600 | `#006975` cyan-700 | `#E2F8FA` cyan-50 | gauge |
| `flat_fee` | `recurring` | Periodic charge (charge period shown beside) | `#2E45A9` primary-500 | `#1B2A68` primary-700 | `#EDF0FB` primary-50 | repeat |
| `flat_fee` | `oneTime` | One-time charge (was `once`) | `#4C5462` neutral-600 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | zap |
| `capacity_commitment` | `commitment` | Billable-quantity floor — a constraint on the base rate, not a charge of its own | `#1A73D9` info-500 | `#0C4084` info-700 | `#E7F1FD` info-50 | arrow-down-to-line |
| `capacity_motivation` | `discount` | Graduated per-unit discount above a target quantity | `#E6007E` accent-500 | `#91004F` accent-700 | `#FDE6F1` accent-50 | trending-down |

`flat_fee` is the **one `component_type` with two variants**: its label and hue come from the envelope's `price_component.priceType` (`recurring` vs `oneTime`), never from the charge-period columns — a `flat_fee` with no period is `oneTime`, not a broken recurring price.

**Why Accent, not the AI family, for `capacity_motivation`.** A catalog discount reuses the shared Accent scale for the same reason §8's "Negotiated" pill does — the §0 AI/Iris exclusion applies in full, and Accent is the brand's own energy accent. The two never render in the same view (catalog pricing panel vs the Orders/Subscriptions tables) and carry different icons (`trending-down` vs `handshake`), so the reuse is not a collision. This is a **badge tint**, not an accent-filled action: §5's "`--action-cta-bg` exactly once per view" rule is untouched.

**The badge reads the `component_type` column, never the JSON.** `component_type` always equals `price_component ->> '@type'` (Inv. #30), so a table cell never parses the envelope to decide how to render itself; the one envelope field it does read is `priceType`, for the `flat_fee` split above. A row whose column and envelope disagree is corruption, not a variant — render nothing rather than guessing.

`negotiated_override` gets **no badge here** — it is the logical/TMF projection of an ordering-table row (PC9/Inv. #39), never a catalog component and not even persistable in this table, and it is already wired as the Orders/Subscriptions "Negotiated" pill (§8/§9). The badge's total record therefore covers **four** component types, not the Zod union's five.

---

## 3. Offering Flags & Spec Chips

**Flag chips** (`is_bundle`, `is_sellable`, billing-only) render only when true — quiet neutral chips (`--radius-xs`, neutral-100 bg, neutral-700 text) with icons `boxes` / `shopping-cart` / `receipt`. Exception: a false `is_sellable` on an `ACTIVE` offering shows a warning-tinted "Not sellable" chip (warning-50 bg / warning-700 text), since that combination is what Billing Ops needs to notice. `is_bundle` keeps this exact treatment everywhere it's displayed, including on Manage Products; `OfferingForm` never renders an input for it, in create or edit mode — the chip is genuinely display-only, not just "unbuilt."

**Spec characteristics** (`product_spec_characteristics` JSONB, e.g. `SST_ID: 01`, `SD_ID: A0C4E2`) render as plain inline text — no chip/pill treatment (revised 2026-07-09 — density pass): key in muted text, value in `--text-mono` inline. Mandatory/default indicators on spec cards reuse info-50/info-700 (`Mandatory`) and neutral-100/neutral-700 (`Default: …`) tints.

---

## 4. Price Effectivity States

A price's end is derived from its successor's `start_date_time`; cards signal temporal state without new hues. **Pricing-components update:** succession now resolves per `(component_type, unit_of_measure)` lane (the rekeyed uniqueness index, PC14) — a new `capacity_motivation` never supersedes the `usage_rate` beside it, and each lane computes Current / Future-dated / Superseded independently:

| State | Rule | Treatment |
|---|---|---|
| Current | effective now | Default card; left border `#00A9BC` cyan-500 (connectivity = "live") — a **functional** state marker (only the current price carries it), not a decorative accent stripe; it earns its pixels by distinguishing the live price from future/superseded at a glance |
| Future-dated | `start_date_time` in future | info-50 bg tag "Starts <date>" in info-700; default card otherwise |
| Superseded | successor already started | Card muted (`--text-muted`), tag "Superseded" neutral-100/neutral-700 |

`capacity_motivation.steps` render each step's threshold and rate as plain inline text in ascending order (e.g. `base 100; above 1000: 50; above 2000: 25`), semicolon-separated — no table. This inherits the density rule the dropped tiered rendering established (revised 2026-07-09 — density pass); `pricing_model = 'tiered'` no longer exists (PC8). A `capacity_commitment` renders as `committed 1,000 EA` — quantity and unit only, **no currency**, because the component carries no money.

**`rateCardLookUp` renders as a name only (Inv. #42, unamended).** Nothing in this delivery resolves it, so the rule stands in full: **no link, no lookup affordance, nothing that implies resolvability**. It is **free text with no FK**, so the authoring form gets **no autocomplete and no typeahead**. It renders as plain `--font-mono` text, with a muted *"default rate"* beside it when null (§5). A card is routinely named on an offering before any version is uploaded, and whether a future consumer should check that the name resolves to a stored version is OR5 — out of scope here.

A future-dated price can only be added while the version is `DRAFT`, so the "Future-dated" tag appears on a `DRAFT` version's panel and on the fixed schedule a released version carries — never as something a user can add to a live version.

**Not-yet-billable warning (O10).** A component that saves but nothing downstream can bill yet reuses the `--bg-warning`/`--text-warning` treatment of §7's warnings, inline under the component row. The two tiered copies are **retired with `pricing_model = 'tiered'`**; the surviving cases are the two capacity modifiers: *"Bill run does not apply a capacity commitment yet — this component is stored but not billed."* and *"Bill run does not apply a capacity motivation yet — usage bills at the base rate until then."* (The rate card update does **not** touch this pricing panel — a `usage_rate` naming a `rateCardLookUp` is unaffected here.) A third case comes from an open modelling gap (architecture §7): the capacity components are **quantity**-based, but `Mbps` is a rate, so a commitment or motivation in `Mbps` has no stated basis (per month? per peak sample?) — *"A capacity component in Mbps has no agreed basis yet; confirm what the committed quantity means before this version goes live."* It warns rather than blocks, because the unit list is closed and no rule forbids the combination. Warning only, all four: none blocks the save. A missing charge period, a unit outside the list, or an unmapped period is still a `FieldError`, not this banner — as are the cross-component rules (§7), which block it.

---

## 5. Module Typography & Surface Notes

Use `--font-mono` for the sequence IDs (`PRDOFR…`, `PRDSMD…`, `PRDOFP…`), GL codes, SST/SD values, and `version`; enable `tabular-nums` on amounts, step thresholds/rates, committed quantities, charge-period lengths, and the version column — identical on Manage Products' table. Amount rendering is keyed to `component_type`, not to a price type: a `usage_rate` renders `ratePerUnit / unit` (`RM 0.05 / GB`), a `recurring` `flat_fee` renders `amount / period` (`RM 5,000.00 / month`), and a `oneTime` `flat_fee` renders the bare `amount` — **no unit**, since `unit_of_measure` is NULL on every `flat_fee` row (architecture §3.3). Unit and period are read from the row's columns, never from `params` and never inferred; the unit keeps its stored casing exactly (`Mbps`, never `MBPS`). Amounts render `--text-h4` weight 600 with currency code in `--text-caption` muted. **Pricing-components update:** envelope money is a **decimal string** (`"100"`) — format it for display with the row's `currency` and never re-parse it to a different precision; `committedQuantity` and every `steps[].aboveQuantity` are numbers and take `tabular-nums` like the amounts; a `rateCardLookUp` name renders in `--font-mono` alongside the sequence IDs, with a muted "default rate" beside it when null. **Rate card update:** `RCV########` version ids and the `PRDINV########` `lkp_subscriber_ref_id` values the lookup rows carry join the mono set, and `tabular-nums` extends to row counts and diff change counts. Raw `component_type` / `@type` values are never shown — the §2 badge label is the user-facing name, and the derived envelope fields (`specVersion`, `plaSpecId`, `appliesAt`, `basis`, `boundTo`) are never surfaced at all. Selected offering row uses the shared `--surface-selected`; View Product's sections 2–4 are `--surface-card` on `--surface-app` with `--border-default`.

`--action-cta-bg` is used exactly once across the module: the "New offering" button in the Manage Products page header. It remains the **only** accent-filled primary action on that page (per the shared design system's "one accent button per view" rule) — every other action (Edit, Add price, Activate) uses the quieter secondary/ghost treatment; only Retire/Discard use the danger role, and only inside their confirmation dialogs. (The Activate-confirmation dialog's own "Activate" button is the one other place an accent button appears — acceptable since it never renders in the same view as the page-header CTA.)

---

## 6. Module Usage Notes

- **Badges (§1–2)** render dark `-fg` text on the light `-bg` tint — never white-on-tint — and always pair icon + label so meaning never depends on color alone (`RETIRED` vs `once` vs superseded are all grayish by design; icons disambiguate). This applies to every row-action icon button on Manage Products too.
- Empty panel states ("Select an offering", no specs/prices, "no versions beyond this one") use `--text-muted` on `--surface-sunken`; no gradients. A family with only one version shows no expand chevron at all, rather than an expand control that reveals nothing.
- **Families-table empty states are two distinct features, not one blank grid.** (1) **Fresh catalog** (no families at all): a warm `--surface-sunken` panel, one line ("No products yet. Create the first offering to start the catalog."), pointing at the page-header "New offering" CTA — do not repeat the accent button in the empty state, just reference it. (2) **No search/filter match**: a distinct state naming the query — "No products match \"`<q>`\"" (and/or the active status filter) — plus a quiet "Clear filters" action that resets `q`/`status`. The two must read differently so "you have no catalog yet" is never confused with "your filter hid everything." (pm39 `FamilyTable`.)

---

## 7. Manage Products — Component Wiring

Patterns that exist only on the CRUD page — View Product never needed them.

**Version-level action buttons.** Icon-only, 28px square, `0.5px solid var(--border)`, icon + `aria-label` (§6). **Touch targets:** 28px is the fine-pointer (mouse) size; under `@media (pointer: coarse)` the buttons and the version-bar chips grow to a 44px minimum hit area (padding, not icon size) so a tablet user does not mis-tap catalog actions. Manage Products is a desktop-first admin surface, but the coarse-pointer bump is cheap insurance and is the spec, not an implementation guess. They render **once, in the selected version's header** — not on every list row (the families table carries navigation and status only):

| Action | Icon | Color role | Shown on |
|---|---|---|---|
| Edit | `edit` | `--text-secondary` (quiet) | `DRAFT`, `ACTIVE` (an `ACTIVE` edit branches a new draft) |
| Add price component | `cash` | `--text-secondary` (quiet) | `DRAFT` only |
| Submit for testing | `flask-conical` | `--text-secondary` (quiet) | `DRAFT` only |
| Back to draft | `undo-2` | `--text-secondary` (quiet) | `TESTING` only |
| Activate | `check` | `--text-secondary` (quiet — not accent; the CTA stays reserved for "New offering") | `TESTING` only |
| Stop selling | `ban` | `--text-danger` | `ACTIVE` only |
| Retire | `archive` | `--text-danger` | `OBSOLETE` only |
| Discard | `trash` | `--text-danger` | `DRAFT`, `TESTING` (never `ACTIVE` and later) |
| — | — | — | `RETIRED` shows no actions — muted, replaced with plain `--text-muted` text, "No actions — retired." |

**Inline panel editing.** On a `DRAFT` version the specifications and pricing panels edit in place: a row shows its value as text until activated, then an input with explicit **Save** and **Cancel** (secondary/ghost, never accent). No auto-save on blur. On any other status the panels render their read-only variant — plain text, no disabled inputs and no greyed controls, so "not editable now" never looks like "broken". **Keyboard contract (pm41):** `Esc` cancels and restores the prior value; `Enter` saves a single-field row and `Cmd`/`Ctrl+Enter` saves a multi-field row (so `Enter` inside a text field doesn't submit prematurely); on save, focus returns to the edited row; on cancel, focus returns to the control that opened the editor. One row editable at a time (activating a second while one is dirty prompts to discard).

**"This creates a new draft" warning.** Shown inside the Edit dialog and the Add Price dialog whenever the target offering's current status is `ACTIVE` (never on a `DRAFT` target). Treatment: `--bg-warning` background, `--text-warning` text, `--radius` corners, no icon needed (the copy itself is the signal) — same tint pairing as the `DRAFT` lifecycle badge (§1). Copy pattern: *"`<Name>` is active. Saving will not change it — a new draft version is created instead."*

**Component picker (pricing-components update).** The Add Price dialog leads with a `component_type` choice — the §2 badge label plus one line of help — offering exactly the **four persistable types**; `negotiated_override` never appears, because it cannot be written to this table (Inv. #39). The rest of the form is the chosen branch's `params` only. Two row-level fields sit **above** the branch but are not uniformly present, because the completeness rules differ per type (architecture §3.3):

| Branch | `unit_of_measure` | Recurring period pair |
|---|---|---|
| `usage_rate` | required | hidden |
| `flat_fee` — `priceType: recurring` | **hidden** (NULL on the row) | required |
| `flat_fee` — `priceType: oneTime` | **hidden** (NULL on the row) | hidden |
| `capacity_commitment` / `capacity_motivation` | required | hidden |

`currency` is the one field every branch shares (PC3/VI5) and stays above the picker. A field that is NULL for a branch is **hidden, not disabled** — the same rule §7's read-only panels follow, so "not applicable here" never reads as "broken". `capacity_motivation.steps` is an add/remove row list the form keeps in ascending order, not a free-text JSON field.

**Cross-component (offering-level) errors.** The pricing-components update adds validity rules that belong to **no single field**: a `post_aggregation` modifier with no same-unit `usage_rate` (VI3), an ambiguous base-rate binding (VI4), and two components of one offering in different currencies (VI5). These render as a **panel-level error banner at the top of the pricing panel** — danger role (`alert-triangle` in `--text-danger` on the danger tint, the §7 dialog construction), naming the offending components by their §2 badge label. Not a `FieldError` (there is no field to attach to) and deliberately **not** the §4 warning tint, which would understate a rule that blocks the save. Copy states the missing counterpart, not the rule name: *"Target Capacity Commitment needs a base usage rate in EA. Add one before saving."* Save stays disabled while the banner is present — the one place in this module where a pricing error is not row-local.

**Backdating warning.** Shown inside the Add Price form when the chosen start date is in the past but within the 3-day tolerance. Same `--bg-warning`/`--text-warning` treatment as above. Copy pattern: *"This price is backdated to `<date>`; historical bills may be affected."* A start date beyond the tolerance is a validation error (standard `FieldError` red-text treatment, not this banner), not a warning.

**Withdrawal and discard dialogs.** Three separate dialogs, all on the shared `AlertDialog` danger pattern (`alert-triangle` in `--text-danger`, danger-role confirm button):

| Dialog | Shown on | Body copy pattern | Confirm button |
|---|---|---|---|
| `DeleteVersionDialog` | `DRAFT`, `TESTING` | *"Discarding `<Name>` v`<n>` deletes this version with its `<x>` specifications and `<y>` prices. It never went live and this cannot be undone."* | "Discard version" |
| `ObsoleteOfferingDialog` | `ACTIVE` | *"`<Name>` will stop being available for new orders. Existing subscriptions keep billing from this version unchanged."* | "Stop selling" |
| `RetireOfferingDialog` | `OBSOLETE` | *"No subscription depends on `<Name>` v`<n>` any more. Retiring is final."* Blocked state instead of the confirm button when the gate fails: *"`<n>` subscriptions still bill from this version. It can be retired once they end."* | "Retire version" |

Each carries an optional "Reason" text input — `FieldLabel` reads "Reason (optional)", placeholder gives a realistic example, not "e.g." boilerplate.

**Submit-for-testing dialog.** `SubmitForTestingDialog`, a plain confirmation (not danger — nothing is destroyed). Body copy states what locks: *"`<Name>` v`<n>` becomes read-only while in testing. Return it to draft to make further changes."* Precondition failures render as field-level errors in the panels they come from (no prices; an unresolved mandatory specification), never as dialog copy.

**Families list and version bar.** The Manage Products table shows **one row per family** — its `ACTIVE` version, else its open (`DRAFT`/`TESTING`) version, else its highest version — with a version count. There is no expand chevron and no indented sub-rows. Selecting a row reveals the **version bar**: one compact entry per version (version number + `LifecycleBadge`), the selected entry carrying `--surface-selected`, the rest `--surface-sunken`. A family with one version renders the single entry rather than an affordance implying more. **Overflow (many versions):** entries order **newest-first** (so the newest version — the open `DRAFT`/`TESTING` if any, else the live one — stays at the left edge, visible without scrolling) and the bar **scrolls horizontally** with an edge-fade affordance when they exceed the width — never wraps to stacked rows (which would push the panels down unboundedly). **Keyboard:** entries are plain `<Link>`s (tab-navigable), the selected one carrying `aria-current="page"` and an `aria-label` like "Version 3, active" (pm40 I4) — navigation, not a `tablist`.

**Activate confirmation.** Not a danger dialog (activation isn't destructive) — a plain confirmation dialog, default button styling for "Cancel," accent-filled for "Activate" (the one place besides "New offering" where an accent button appears — acceptable since they never render in the same view). Body copy states plainly what happens to the family's current live version: *"`<Name>` v`<n>` becomes orderable. The version currently active becomes obsolete — existing subscriptions keep billing from it unchanged."* Includes the same optional "Reason" field as the dialogs above.

---

## 8. Ordering — Orders Page (pm27)

Patterns for `/products/orders`. `--action-cta-bg` is used exactly once on this page too ("New order," same one-accent-button-per-view rule as Manage Products' "New offering" — the two pages never render together, so no conflict).

**`OrderStatusBadge` (TMF622 order status).** Same pill construction as `LifecycleBadge`/`PricingComponentBadge` (§1/§2 — dark `-fg` text on light `-bg` tint, icon + label, never color-only). All nine seeded `ORDER_STATUSES` get a variant; the phase only ever writes `ACKNOWLEDGED`/`PENDING`/`COMPLETED`/`REJECTED`/`FAILED` (architecture §3), so the remaining four (`HELD`/`IN_PROGRESS`/`CANCELLED`/`PARTIAL`) render if the full enum is ever exercised but are otherwise unused:

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

**`SubscriptionStatusBadge` (TMF637 subscription status).** Same pill construction as `LifecycleBadge`/`PricingComponentBadge`/`OrderStatusBadge` (§1/§2/§8). All eight seeded `PRODUCT_STATUSES` get a variant; the phase only ever writes `ACTIVE`/`SUSPENDED`/`TERMINATED` (architecture §3), so the remaining five render if the full enum is ever exercised but are otherwise unused:

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

---

## 10. Rate Card — Version Lifecycle, Upload & Diff (rate card lookup update)

Patterns for `/products/rate-card`, the fifth Products page. This delivery stands up the `RATECARD_RAN_USAGE_LKP` table and its read/write surfaces; the rating consumer that reads the table is a following-sprint deliverable. Nothing here is a new token: every hue is a shared semantic pair already used elsewhere in this file. **Nav:** lucide `TableProperties` in `components/nav-icons.ts` (the mockup's tabler `table-options`) — a table-with-settings glyph, no collision with `Package` / `PackagePlus` / `ClipboardList` / `Layers`. The entry is hidden when `ratecard : READ` is denied, never shown locked (the existing `NAV_REGISTRY` convention).

### 10.1 `RateCardStatusBadge`

A **separate total record from `LifecycleBadge`**, not a reuse of it — same pill construction (§1: `--radius-pill`, `-bg` tint, `-fg` text, icon + label) but a different four-value vocabulary, so the two must not share a type. `DRAFT`, `ACTIVE` and `SUPERSEDED` deliberately keep §1's hues and icons, because the words mean the same thing here:

| `status` | Meaning | Base / icon color | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|---|
| `DRAFT` | Uploaded and validated; previewable; **invisible to every rating run** until activated | `#E08600` warning-500 | `#8A5200` warning-700 | `#FEF4E6` warning-50 | pencil-line |
| `ACTIVE` | The one live version for this card name — DB-enforced by the partial unique index | `#1F9D57` success-500 | `#0F5C32` success-700 | `#E6F6EC` success-50 | check-circle |
| `SUPERSEDED` | Replaced by a later activation; immutable and **re-activatable** (rollback) | `#4C5462` neutral-600 | `#353B46` neutral-700 | `#EEF0F4` neutral-100 | history (render row muted) |
| `REJECTED` | Defined in the column, **unreachable in v1** — a failed upload inserts nothing (RC7), so no version ever reaches this status | `#D92D2D` danger-500 | `#8A1717` danger-700 | `#FDEAEA` danger-50 | x-circle |

**`DRAFT` takes warning, not info — the mockup is superseded here.** `mockup-product-rate-card.html` tints Draft with info-50/info-700. That is rejected: `DRAFT` must mean one thing app-wide, info is §1's `TESTING` hue (which has no rate-card analogue, so borrowing it would make the same word read differently on two Products pages), and a card draft is precisely shared §3.4's *pending — awaiting a decision*. The consequence is that warning is then **spoken for on this page** (Draft badge, the validation tab's warning count).

`REJECTED` gets a variant for totality, exactly as §8's four unwritten order states do — present so the union is closed, not because the phase writes it.

### 10.2 Diff categories (`RateCardDiffBadge`)

The three categories render **in one view** (chip row plus a per-row column), so they must be mutually distinguishable by hue *and* icon. Ordered by billing consequence, which is the order the diff itself uses:

| Category | Meaning | `-fg` text | `-bg` tint | Icon |
|---|---|---|---|---|
| Added | A key absent from the current `ACTIVE` version | `#0F5C32` success-700 | `#E6F6EC` success-50 | plus |
| Changed | A key present in both versions whose value differs | `#0C4084` info-700 | `#E7F1FD` info-50 | pencil-line |
| Removed | Present in the current `ACTIVE` version, absent from the upload — not in the new version; stays readable in the superseded one (D-A7) | `#8A1717` danger-700 | `#FDEAEA` danger-50 | archive |

**Removed takes danger, a deliberate departure from §1.** §1 renders end-of-life (`OBSOLETE` / `RETIRED`) as neutral and muted; here that would bury the only change a user cannot undo without a rollback — the key is absent from the version going live. The label is **"Removed"**, never "Deleted": the row is not destroyed, it remains in the superseded version. There is no carry-forward copy and no closing date (D-A7).

**Changed-value cells** show both states inline: the old value `--text-muted` with `line-through`, the new value `--text-primary` weight 500, both `--font-mono`. No red/green fill on the cell itself — the row's category badge already carries the color.

### 10.3 The rate-per-unit column

`rate_per_unit` is a plain **optional** column on the row preview: render the value in `--font-mono` when present, and a plain `—` in `--text-muted` when null — the same not-applicable treatment used everywhere else in the module. No italic, no "base rate" placeholder, no reserved-column rationale.

### 10.4 Page banners

| Banner | Tint | Icon | Placement | Blocking |
|---|---|---|---|---|
| Upload rejected — no version created | `--bg-danger` / `--text-danger` | ban | Top of the error dialog body | The upload already failed |
| Validation passed, with warnings | `--bg-info` / `--text-info` | check-circle | Top of the Validation tab | Never — the only warning is a duplicate-upload checksum match, which does not block activation |
| Removed rows stay readable in the superseded version, which can be rolled back to | `--bg-info` / `--text-info` | info | Inside the Activate confirmation | Never |

### 10.5 Version list, selected-version header, tabs

**Version list.** One row per version, newest first: `RCV########` (mono), `RateCardStatusBadge`, snapshot date, row count (`tabular-nums`), uploader / activator and timestamps. The selected row takes `--surface-selected`; a `SUPERSEDED` row renders muted, per §1's convention for superseded things. A "One Active version per card" note sits in the card header in `--text-muted` with a `lock` icon — it states a DB guarantee, so it is informational, not a warning.

**Selected-version header** carries a metadata strip — `--surface-sunken`, `--text-overline` labels over `--text-primary` weight 500 values — for card name, snapshot date, row count, checksum (mono, middle-truncated `a91f…3c02`), validation result and the version it replaces. Dates render ISO (`YYYY-MM-DD`) throughout this page rather than localized: `polygon_start_date` is a **match key read out of the file**, and `snapshot_date` is the **upload's calendar date** stamped by the server (D-A8) — neither is a human-facing schedule date. The `snapshot_date` label may read "Snapshot date" or "Uploaded on"; the value stays ISO.

**Tabs — a new pattern for this module.** Rows / Diff vs Active / Validation, each with a count chip. Underline tabs: `--radius-none`, inactive `--text-muted`, active `--text-link` with a 2px `--color-primary-500` bottom border, on `--surface-card` above a `--border-default` hairline. Tabs rather than §7's version bar because these are **three views of one version**, not a selection among records — the version bar's job is already done by the list above. Tab state is URL-driven (`?tab=`), matching the module's deep-link convention (code-standards §3.5).

### 10.6 Actions, CTA budget and dialogs

| Action | Icon | Color role | Shown on |
|---|---|---|---|
| Upload new version | `upload` | `--action-primary-bg` (**indigo, not CTA**) | Page header, always |
| Download template | `download` | secondary outline | Page header, always |
| Activate version | `check-circle` | `--action-cta-bg` | `DRAFT` only |
| Discard draft | `trash` | `--text-danger` | `DRAFT` only |
| Roll back to this version | `history` | `--text-secondary` (quiet) | `SUPERSEDED` only |
| Export rows / diff / errors | `download` | secondary outline | Per tab, and the error dialog |
| — | — | — | `ACTIVE` shows no mutating action at all — versions are immutable, and replacing one is an upload, not an edit |

**`--action-cta-bg` is used exactly once on this page: "Activate version".** This is the **first page in the module where the accent is not on a creation button** — "Upload new version" creates a record and therefore takes `--action-primary-bg`, per the shared §3.3 rule that record-creation triggers never take the CTA. Activation is the single featured confirm and the only act on the page with billing consequence, so the budget is spent exactly where the rule intends. The mockup agrees.

**Dialogs.**

| Dialog | Pattern | Body copy | Confirm |
|---|---|---|---|
| Upload | Plain, `upload` icon in `--text-link` | Drop zone (2px dashed `--border-strong` on `--surface-sunken`, `--radius-md`, `file-spreadsheet` in `--text-disabled`), card-name select, and a hint: *"Uploads land as **Draft**. Nothing is used by a rating run until you activate it."* | "Upload & validate", `--action-primary-bg` |
| Upload rejected | **Not** an `AlertDialog` — a plain dialog with `alert-triangle` in `--text-danger`; the failure already happened, there is nothing to confirm | Danger banner *"No version was created. Fix the file and upload again."* then a Row / Column / Reason table — row numbers `tabular-nums`, column names `--font-mono`, reason in plain body text quoting the validator verbatim (*"Polygon Start Date must be a real date in YYYY-MM-DD form"*) | "Close", `--action-primary-bg`; "Export errors" secondary |
| Activate | Plain confirmation, **not danger** (§7's Activate-confirmation construction) | Names the superseded version, then the three §10.2 change counts (added / changed / removed) in a metadata strip, then the removed-rows note (§10.4) | "Activate", `--action-cta-bg` |
| Roll back | Plain confirmation, **not danger** — versions are immutable, so nothing is lost and the move is itself reversible | Names the version being demoted and repeats the same change counts, computed in the other direction | "Roll back", `--action-cta-bg` |
| Discard draft | Danger `AlertDialog` (§7's `DeleteVersionDialog` construction) | *"Discarding `<RCV…>` deletes this version and its `<n>` rows. It never went live and this cannot be undone."* | "Discard version" |

Activate and Roll back each carry an accent confirm and **never co-render** (a version cannot be both `DRAFT` and `SUPERSEDED`), so the one-accent-per-view rule holds — the same allowance §5 already grants the catalog's Activate dialog.

### 10.7 Read-only, empty and touch treatments

- **`ratecard : READ` only** — the version list, row preview, diff and validation tabs all render in full; every action in §10.6 is **absent, not disabled**, the rule §7 already follows for non-editable panels.
- **Two distinct empty states**, as §6 requires of the families table: *no versions yet for this card* ("No versions yet. Upload a CSV to create the first one.", pointing at the header button without repeating it) must read differently from *no rows match this filter* ("No rows match \"`<q>`\"" plus a quiet "Clear filters").
- **Row preview and diff are paginated and filterable** — 5,400 rows never render at once, and the footer states `Showing 1–n of N` in `--text-muted`.
- **Touch targets** follow §7: 28px icon buttons at fine pointer, a 44px minimum hit area under `@media (pointer: coarse)`. The drop zone is already well past 44px.
