# pm41 — Inline editing of a DRAFT version

**Unit:** pm41 (Part 3). **Boundary:** `components/products/manage/**` plus the page wiring that passes actions into the panels. No new service, no new repository method, no schema.
**Specs from:** `prodmgmt-update-overview.md` flow steps 5–7, criterion 2 · `prodmgmt-code-standards.md` §3.6, §4.8, §4.11, §1.19 · `prodmgmt-ui-context.md` §7 · plan D3.
**Depends on:** pm38 (price write actions), pm40 (the panels these variants replace).

---

## Goal

Make the specifications and pricing panels editable in place when the selected version is `DRAFT` — add, change and remove rows without a dialog — and render the read-only variant on every other status.

---

## Design

### D1. Editable variants wrap the read-only ones

`ManageSpecificationsPanel` and `ManagePricesPanel` take `canEdit: boolean` plus the existing read models. When `canEdit` is false they render View Product's components untouched (pm40's path). When true they render the same rows with an edit affordance per row and an "Add" control per section. One component per panel with a boolean, not two parallel components — the read-only and editable layouts must not drift apart.

### D2. Row-level editing, explicit Save and Cancel

A row shows its values as text. Activating it swaps that row — and only that row — for inputs, with Save and Cancel buttons in quiet secondary/ghost styling. No auto-save on blur, no optimistic row mutation: the server action's typed result is what updates the view, and a failure leaves the row in edit mode with its `FieldError`s populated. Exactly one row per panel is editable at a time; activating a second row while one is dirty prompts to discard.

**Keyboard contract (design review, `prodmgmt-ui-context.md` §7).** `Esc` cancels and restores the prior value; `Enter` saves a single-field row, `Cmd`/`Ctrl+Enter` saves a multi-field row (so `Enter` inside a field never submits prematurely). On save, focus returns to the edited row; on cancel, focus returns to the control that opened the editor. No focus trap, no focus loss to `document.body` — the read-only row that replaces the editor is focusable and receives focus.

### D3. Read-only means plain text, never disabled inputs

On `TESTING`, `ACTIVE`, `OBSOLETE` and `RETIRED` the panels render the plain read-only variant with no controls at all. A greyed-out input reads as "broken"; an absent control reads as "not available here". The version header carries the explanation instead ("Testing — return to draft to make changes", "Active — editing creates a new draft").

### D4. Editing an ACTIVE version routes through the branch, from the header

The panels themselves are never editable on `ACTIVE`. The header's Edit action calls `updateOfferingAction`/`insertPriceAction` as today, which branch first, and the page then navigates to the new draft's `?version=`. The "this creates a new draft" banner stays where it is (`prodmgmt-ui-context.md` §7) — shown before the branch happens, not after.

### D5. Which client components exist

Only the editable row and the add-row form are `'use client'`. The panels, the version bar, the table and the page stay server components (code-standards §3.6). A panel does not become a client component because one row inside it can be edited.

### D6. Two dialogs retire

`SpecificationsDialog` and `AddPriceDialog` are deleted; their content lives in the panels. `PriceForm` and `SpecificationForm` survive as the field groups both the inline editor and the create flows use — they are forms, not dialogs, and pm38 already extended `PriceForm` with the period and unit fields.

---

## Implementation

### I1. `components/products/manage/manage-specifications-panel.tsx` (new)

Renders `SpecificationCard[]`. Per row when `canEdit`: name, mandatory/default flags, default value, characteristics (key/value rows). Edit swaps to `SpecificationForm`'s fields; Save calls `updateSpecificationAction`; Delete calls `deleteSpecificationAction` behind a small inline confirm (not an `AlertDialog` — a draft spec is not a destructive loss). "Add specification" appends an empty editor calling `createSpecificationAction`.

### I2. `components/products/manage/manage-prices-panel.tsx` (new)

Renders `PriceCard[]` grouped by price type, each group ordered by `startDateTime`. Per row when `canEdit`: Edit swaps to `PriceForm`; Save calls `updatePriceAction`; Delete calls `deletePriceAction`. "Add price" opens an inline `PriceForm` calling `insertPriceAction`. The effectivity tag, the tier rendering, the warning banners (backdating, unbillable shape) all come from the existing components and pm38's work — this unit adds no new copy.

### I3. Error and result handling

Each action's typed result maps to UI without a `try/catch` around business outcomes:

| Result | UI |
|---|---|
| `VALIDATION_ERROR` | field errors on the row, stays in edit mode |
| `OFFERING_NOT_DRAFT` | row exits edit mode, panel refreshes, banner: "This version is no longer a draft — reload to see its current state" |
| `DUPLICATE_START` | field error on the start date |
| `BACKDATED_START_TOO_FAR` | field error on the start date |
| `PRICE_NOT_FOUND` / `OFFERING_NOT_FOUND` | panel refreshes with the row gone |
| `FORBIDDEN` | inline "You no longer have permission to edit products" |
| `SERVER_ERROR` | generic inline error; the row keeps the user's input |

`OFFERING_NOT_DRAFT` appearing at all means someone else advanced the version mid-edit; it is a normal race, not a bug.

### I4. Page wiring

`page.tsx` computes `canEdit = selectedVersion.lifecycleStatus === 'DRAFT'` from the same total `Record` pm37 introduced (never an inline string comparison) and passes it down. The selection region renders the manage panels instead of the raw View panels when the page is Manage Products.

### I5. Deletions

Remove `specifications-dialog.tsx` and `add-price-dialog.tsx` and their imports. Update `prodmgmt-code-standards.md` §4.8's component list and §7's tree in the same change set (the `(del)` markers become deletions).

### I6. Tests

- `tests/components/manage-prices-panel.test.tsx`: edit → save happy path; validation error keeps edit mode with field errors; delete removes the row; add appends; only one row editable at a time; no controls render when `canEdit` is false.
- `tests/components/manage-specifications-panel.test.tsx`: the same five cases.
- `tests/app/manage-products-editing.test.tsx`: a `DRAFT` renders controls, a `TESTING` version renders plain text with no disabled inputs, an `ACTIVE` version renders the header Edit affordance and the branch banner.
- Guardrail: `components/products/manage/` contains neither deleted dialog; `PRODUCT_ACTION_FILES` unchanged from pm38 (this unit adds no action).

---

## Dependencies

**Packages to install: none.** The inline editor uses the existing form primitives (`FieldLabel`, `FieldError`, `Button`) and React's own `useState`/`useTransition`. No form library, no table library, no drag-and-drop.

---

## Verification checklist

- [ ] On a `DRAFT`, a spec and a price can each be added, edited and deleted from the panel without a dialog.
- [ ] Save is explicit; blurring a field saves nothing; Cancel restores the previous values.
- [ ] Keyboard: `Esc` cancels/restores, `Enter` (single-field) / `Cmd`·`Ctrl+Enter` (multi-field) saves; focus returns to the row on save and to the trigger on cancel — no focus loss.
- [ ] A validation failure keeps the row in edit mode with field-level messages; the user's input is not lost.
- [ ] On `TESTING`, `ACTIVE`, `OBSOLETE`, `RETIRED` the panels show plain text and no controls — no disabled inputs anywhere.
- [ ] Editing an `ACTIVE` version from the header branches and lands the user on the new draft, with the banner shown beforehand.
- [ ] Only the row editor and add-form are client components; panels, version bar, table and page remain server components.
- [ ] `SpecificationsDialog` and `AddPriceDialog` are gone, along with their imports and doc entries.
- [ ] `OFFERING_NOT_DRAFT` mid-edit refreshes the panel with an explanation rather than throwing.
- [ ] Query budget from pm40 is unchanged by the edit affordances.
- [ ] `tsc --noEmit`, ESLint, Prettier clean; no service, repository or schema change in this diff.

**Definition of done:** a Revenue Ops user fixes a wrong price on a draft in the panel where they read it, and the same panel on the live version offers nothing to click.
