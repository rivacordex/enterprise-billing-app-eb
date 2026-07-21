# Enterprise Billing App — Product Management Module
## UI Context Addendum (Phase 2: CRUD Fast-Follow)

**Status:** PLANNED — decisions agreed 2026-07-20, pre-implementation. See `_change-product-crud-plan.md` and `prodmgmt-project-overview-phase2.md`.
**Base document:** `prodmgmt-ui-context.md` (v1, shipped, **unchanged by this addendum**). Read that document first — this file records **only what Phase 2 adds or changes**, using its section numbers. Anything not mentioned here is inherited unchanged, and still inherits the shared brand system from `context/ui-context.md`.

---

## Relative to §0 (Module Scope & Exclusions)

Both v1 exclusions extend to the new page, not just the old one:

1. **No AI / Iris-violet tokens on Manage Products either.** Phase 2 adds forms and dialogs, not AI/ML features — the exclusion's reasoning (no AI components in this module) applies exactly as much to the new page as the old one.
2. **Manage Products stays flat too.** It's a second data-dense admin screen (a table plus dialogs), not a marketing surface — `--gradient-chrome` stays confined to shared nav/sidebar chrome, same as v1.

## Relative to §1 (Lifecycle Status / `LifecycleBadge`)

No visual change — same three-row table, same colors, same icons, reused as-is on Manage Products' rows. One meaning update: `ACTIVE`'s description gains "and at most one version per product family" (this is a copy/documentation note, not a token or color change — `prodmgmt-architecture-phase2.md` Inv. 6/13 own the enforcement).

## Relative to §3 (Offering Flags & Spec Chips)

`is_bundle`'s flag chip keeps its exact v1 treatment (quiet neutral chip, `boxes` icon, renders only when true) everywhere it's displayed, including on Manage Products. Phase 2 adds a **behavioral** note, not a visual one: `OfferingForm` never renders an input for this field, in create or edit mode — the chip is genuinely display-only now, not just "unbuilt."

## Relative to §5 (Module Typography & Surface Notes)

**Superseded:** v1's closing sentence — *"There is no featured CTA in read-only v1 — `--action-cta-bg` is reserved for the CRUD fast-follow (e.g. 'New offering')."* This is that fast-follow: `--action-cta-bg` is now used, on the "New offering" button in the Manage Products page header. It remains the **only** accent-filled primary action on that page (per the shared design system's "one accent button per view" rule) — every other action (Edit, Add price, Activate) uses the quieter secondary/ghost treatment; only Retire/Discard use the danger role, and only inside their confirmation dialogs.

Everything else in §5 (mono font for IDs/GL codes/version, tabular-nums on amounts, `--surface-selected`/`--surface-card` usage) is unchanged and applies identically to Manage Products' table.

---

## New: Manage Products — Component Wiring (no v1 equivalent)

This section has no corresponding content in the base document — these are UI patterns v1 never needed.

**Row action buttons.** Icon-only, 28px square, `0.5px solid var(--border)`, following the same "icon + `aria-label`, never color-only meaning" rule as v1's badges (§6):

| Action | Icon | Color role | Shown on |
|---|---|---|---|
| Edit | `edit` | `--text-secondary` (quiet) | `DRAFT`, `ACTIVE` |
| Add price | `cash` | `--text-secondary` (quiet) | `DRAFT`, `ACTIVE` |
| Activate | `check` | `--text-secondary` (quiet — not accent; the CTA stays reserved for "New offering") | `DRAFT` only |
| Discard | `trash` | `--text-danger` | `DRAFT` only |
| Retire | `archive` | `--text-danger` | `ACTIVE` only |
| — | — | — | `RETIRED` rows show no action buttons — muted row (same treatment v1's `LifecycleBadge` spec already calls for on `RETIRED`), replaced with plain `--text-muted` text, "No actions — retired." |

**"This creates a new draft" warning.** Shown inside the Edit dialog and the Add Price dialog whenever the target offering's current status is `ACTIVE` (never on a `DRAFT` target). Treatment: `--bg-warning` background, `--text-warning` text, `--radius` corners, no icon needed (the copy itself is the signal) — same tint pairing as the existing `DRAFT` lifecycle badge (§1), reused for consistency rather than inventing a new warning color. Copy pattern: *"`<Name>` is active. Saving will not change it — a new draft version is created instead."*

**Backdating warning.** Shown inside the Add Price form when the chosen start date is in the past but within the 3-day tolerance. Same `--bg-warning`/`--text-warning` treatment as above. Copy pattern: *"This price is backdated to `<date>`; historical bills may be affected."* A start date beyond the tolerance is a validation error (standard `FieldError` red-text treatment, not this banner), not a warning.

**Discard vs. Retire dialog.** One component (`RetireOfferingDialog`, per code-standards-phase2 §4), two copy states selected by the target's current status — both use the shared `AlertDialog` danger pattern (`alert-triangle` icon in `--text-danger`, danger-role confirm button):

| Status at time of action | Title | Body copy pattern | Confirm button |
|---|---|---|---|
| `DRAFT` | "Discard draft" | *"Discarding `<Name>` removes this draft — it never went live and this cannot be undone."* | "Discard draft" |
| `ACTIVE` | "Retire offering" | *"Retiring `<Name>` hides it from new billing selection. This cannot be undone."* | "Retire offering" |

Both include an optional "Reason" text input — a plain, unlabeled-as-required text field, `FieldLabel` reads "Reason (optional)", placeholder gives a realistic example rather than "e.g." boilerplate.

**Version-family grouping.** The Manage Products table shows one row per family by default (its `ACTIVE` version, or latest `DRAFT` if never active). A chevron-style expand affordance (`chevron-down`/`chevron-right`, `--text-muted`, rotates on expand — same interaction convention as any other disclosure control in the app, no new pattern invented) reveals the family's other versions as indented sub-rows beneath the primary row, each with its own status badge and its own row actions per the table above. Non-primary rows use a subtly recessed background (`--surface-sunken`, same token v1's empty-panel states already use) to visually subordinate them to the family's primary row without introducing a new surface token.

**Activate confirmation.** Not a danger dialog (activation isn't destructive) — a plain confirmation dialog, default button styling for "Cancel," accent-filled for "Activate" (this is the one place besides "New offering" where an accent button could appear — acceptable since they never render in the same view: the CTA lives in the page header, this one lives inside a modal triggered from a row). Body copy states the precondition plainly and, when relevant, that activating will retire the family's current active version automatically: *"`<Name>` will become billable once activated. Requires at least one price and all mandatory specs resolved. If another version of this product is currently active, it will be retired automatically."* Includes the same optional "Reason" field as the Discard/Retire dialog.

## Relative to §6 (Module Usage Notes)

Both existing usage notes extend to the new components: icon+label pairing (never color-only meaning) applies to every row-action icon button above; empty-panel muted styling applies to the "no versions beyond this one" collapsed state (i.e., a family with only one row shows no expand chevron at all, rather than an expand control that reveals nothing).
