# PM20 — UI: Edit Offering

- **Unit:** 20 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm13 (`updateOffering` service to call — its exact result shape, four-way routing table, and no-op guard drive this unit's dialog/copy logic directly) and Unit pm18 (the per-row Edit seam, on both a family's primary row and its expanded sub-rows, to fill).
- **Boundary, per the build plan's own words:** "Frontend UI + its Server Action (merged)." This spec honors that boundary with one narrow, explicitly flagged exception — see Design §2.3 (a second, precedented read-model column addition, the same shape pm18 §2.2 already used for `familyOfferingId`).
- **Authorizing sections:** `prodmgmt-project-overview-phase2.md` Core User Flow (steps 8–9: an edit against an `ACTIVE` row "transparently clones it... into a brand-new `DRAFT` version") and Features → Offering management ("a `DRAFT` can be saved in place or explicitly 'saved as new'... an `ACTIVE` offering has no in-place option at all — any edit transparently produces a new draft version instead"); `prodmgmt-architecture-phase2.md` §6 Inv. 14 (editing an `ACTIVE` offering never mutates it in place); `prodmgmt-code-standards-phase2.md` §1 rule 10 (no service `UPDATE`s an `ACTIVE` row's content columns — this unit's UI must make that fact visible, not just true on the backend) and §7 (file tree: `actions/product/update-offering.action.ts`; `offering-form.tsx` gains its edit mode, no separate `edit-offering-dialog.tsx` file — see Design §2.1); `prodmgmt-ui-context-phase2.md` "This creates a new draft" warning banner spec (`--bg-warning`/`--text-warning`, exact copy pattern) and the row-action icon/color table (Edit shown on `DRAFT` and `ACTIVE` only); `mockup-product_module_manage_products.html` (`openModal('edit', i)`'s three concrete cases — DRAFT: Cancel / "Save as new draft" / "Save"; ACTIVE: banner + Cancel / "Create new draft", literally no third button); `pm13-spec.md` (the `updateOffering(offeringId, input, actorId)` service this unit calls — Design's "`offeringId` is a function parameter, not a schema field" decision, which this unit's Server Action and form must both honor; the exact `UpdateOfferingResult` shape with `branched`/`offeringId`); `pm18-spec.md` §2.6/§3.7 (the exact seam comment this unit removes on every Edit button, primary and expanded sub-row alike: `{/* pm20 seam: onClick opens OfferingForm in edit mode */}`) and §2.2 (the precedent this unit's own read-model addition, §2.3 below, directly extends); `pm19-spec.md` (the sibling unit this one mirrors almost throughout: `CreateOfferingDialog`'s `router.refresh()`-not-`router.push()` success handling, its guardrail-assertion-increment convention, its `actions/product/` file shape) and its `OfferingForm`'s own explicit note that "pm20 adds an `OfferingFormEditProps` variant and unions it here... not built in this unit" — this is that unit; `components/roles/role-form.tsx` / `components/users/user-form.tsx` (the two-mode `RoleForm`/`UserForm` union shape this unit's `OfferingForm` follows) and `validation/update-user-details.schema.ts`'s `editUserDetailsFieldsSchema = updateUserDetailsSchema.omit({ userId: true })` (the exact "UI-facing fields-only companion schema, `.omit`-derived, living in the same file as the action-boundary schema" precedent this unit's `editOfferingFieldsSchema` continues — see Design §2.4); `components/roles/role-detail.tsx` (the inline-panel edit-mode precedent this unit deliberately does **not** follow — see Design §2.1); `pm99-build-plan-phase2.md` Unit pm20 (this unit's literal contract).

- **Codebase state verified 2026-07-22 (re-verify before implementing):**
  - **Shipped and committed:** Unit pm10 (`family_offering_id` column), Unit pm11 (`insertOffering`, `services/product/create-offering.ts`, `PRODUCT_OFFERING_CREATED`).
  - **Implemented, not yet committed ("in progress" per the real repo's own progress tracker):** Unit pm12 — `branchOfferingAsDraft` and its `BranchOfferingOverrides` type already exist in `db/repositories/product-offering.ts`.
  - **Not yet started in the real codebase as of this writing:** Units pm13 (`updateOfferingDraftInPlace`, `services/product/update-offering.ts`, `validation/product/update-offering.schema.ts`), pm17 (nav split), pm18 (`app/(app)/products/manage-products/` — the directory doesn't exist; `components/products/manage/` is an empty directory), and pm19 (`actions/product/` doesn't exist; no `OfferingForm`/`CreateOfferingDialog` anywhere). **This spec is written assuming pm13, pm17, pm18, and pm19 will all exist, exactly as their own specs describe, by the time pm20's implementation lands** — per pm99's own dependency graph, the same "spec written ahead of its dependency's actual shipping" stance `pm13-spec.md` and `pm19-spec.md` each took for their own not-yet-shipped prerequisites. Before starting, re-confirm concretely: `services/product/update-offering.ts` exports `updateOffering` returning the exact `UpdateOfferingResult` shape pm13-spec §3.4 describes; `components/products/manage/manage-offering-table.tsx` exists and its Edit buttons (primary rows and expanded sub-rows alike) carry the literal seam comment `{/* pm20 seam: onClick opens OfferingForm in edit mode */}`; `components/products/manage/offering-form.tsx` and `components/products/manage/create-offering-dialog.tsx` exist exactly as `pm19-spec.md` §3.3/§3.4 describe, including the `OfferingFormProps = OfferingFormCreateProps` (not yet a union) and its comment flagging that this unit adds the edit variant. If any of this isn't true yet, this unit has nothing correct to extend and cannot start.
  - `types/product.ts`'s `OfferingListRow` will be `{ productOfferingId, name, lifecycleStatus, version, isSellable, lastModified, familyOfferingId }` once pm18 ships (confirmed against pm18-spec §3.1) — **no `billingOnly` field.** `findDetailById` has `billingOnly`; `findList` (which is what populates every row `ManageOfferingTable` renders) does not. This is the gap Design §2.3 resolves — re-confirm it's still a gap (and that pm18 didn't independently pick it up) before assuming this unit's read-model addition is still needed.
  - `validation/product/update-offering.schema.ts` will exist per `pm13-spec.md` §3.1 exactly as: `{ name (trim, min 1, max 200), isSellable: boolean, billingOnly: boolean, saveAsNew: boolean }`, no `offeringId` key. This unit adds one companion export to that same file — it does not touch the four existing fields.

---

## 1. Goal

Let a `products:EDIT` user click the Edit action on any row (a family's primary row or one of its expanded sibling versions) on `/products/manage-products`, edit name/sellable/billing-only in a dialog whose available save actions depend on that row's own current status — Save or Save-as-new on a `DRAFT`, only "Create new draft" (behind a warning banner) on an `ACTIVE` row — and save: a `DRAFT` target updates in place or produces a sibling per the user's choice, an `ACTIVE` target always produces a new sibling `DRAFT` version, and the whole family-grouped table reflects the result immediately with no page reload.

## 2. Design

### 2.1 One dialog, wired inline in `manage-offering-table.tsx` — deliberately no `edit-offering-dialog.tsx` file

Two existing precedents pull in different directions here, and this spec picks one explicitly:

- `pm19`'s `CreateOfferingDialog` is its own file, wrapping `OfferingForm` plus a `DialogFooter` with a single "Save offering" button bound via `form="offering-form-create"`.
- `components/roles/role-detail.tsx` handles Role's own edit mode with no dialog at all — an inline `mode: "view" | "edit"` toggle inside a permanently-visible detail panel, because Roles has a URL-selected-row concept (`?roleId=`) this page was already built around.

Manage Products has **neither** a per-row detail panel nor any URL-selected-row concept (`pm18-spec` §2.7: no search/filter/sort/pagination controls, no query-string state at all on this page). So the "no dialog, toggle a panel" precedent doesn't fit — Edit has to be a modal, the same conclusion `pm19-spec` §2.1 already reached for Create. But unlike Create, this unit does **not** get its own `edit-offering-dialog.tsx` file: `prodmgmt-code-standards-phase2.md` §7's file tree — the authoritative, already-agreed list of every file this whole phase adds — names `create-offering-dialog.tsx`, `add-price-dialog.tsx`, and `retire-offering-dialog.tsx` as the phase's three dialog wrapper files, and lists none for Edit. Cross-referencing that against `pm99`'s own one-line contract for this unit ("Builds: `actions/product/update-offering.action.ts` plus `offering-form.tsx`'s edit mode... Wired to each row's Edit seam") confirms this is not an omission: Edit's dialog chrome (the controlled `Dialog`/`DialogContent`/`DialogHeader`) is composed directly inside `ManageOfferingTable` — the same component that already owns the row buttons calling it — rather than factored into a fourth dialog file nobody asked for.

Concretely: `ManageOfferingTable` gains one more piece of local state, `editingRow: { row: OfferingListRow; familyId: string } | null` (alongside its existing `expandedFamilies: Set<string>`), and renders exactly one `Dialog` controlled by it, conditionally, near the end of its JSX. Every Edit button — on a family's primary row and on every expanded sibling row alike, since `pm18-spec` §3.7 point 5 gives each version row its own independently-computed action set — sets this same state on click; there is only ever one edit dialog open at a time.

### 2.2 `offeringId` is a function/action parameter, never a form field — continued from pm13

`pm13-spec` Design was explicit: "the id identifying *which row* is being acted on travels as its own parameter, separate from the bag of field values being applied" — `updateOffering(offeringId, input, actorId)`, not a `offeringId` key inside `UpdateOfferingInput`. This unit's Server Action follows the identical shape: `updateOfferingAction(offeringId: string, rawInput: unknown)`, not a single `rawInput` object carrying an embedded id the way `updateUserDetailsSchema`/`updateRoleSchema` do (both of those bundle the target id into the Zod schema itself, then `.omit()` it back out for the form). This unit does not add a `offeringId`-carrying variant of `updateOfferingSchema` at all — there's no reason to, since the id never needs to survive a `safeParse` round-trip; it comes from `editingRow.row.productOfferingId`, known before the dialog even opens.

### 2.3 The one read-model gap this unit closes — `billingOnly` on `OfferingListRow`

`pm18-spec` §2.2 already had to resolve an identical problem for `familyOfferingId` ("exposed nowhere in the current read surface... there is no way to build a correct family-grouped list without exposing it") by adding the one missing column to `OfferingListRow` and to `findList`'s `SELECT`, flagged rather than silently assumed. This unit hits the same shape of gap, one field later: the Edit dialog needs to prefill "Billing only" from the row being edited, and `OfferingListRow` (what `ManageOfferingTable` actually receives as `families[].primary`/`families[].versions[]`) carries `isSellable` but not `billingOnly` — only `findDetailById` (View Product's own read path, unused here) does.

**Resolution, following pm18's own precedent exactly:** add `billingOnly: boolean` to `OfferingListRow` (`types/product.ts`) and to `findList`'s existing `SELECT` (`db/repositories/product-offering.ts`) — one more purely additive column on the same already-precedented function, no new repository method, no new service export, no behavior change for `findList`'s other caller. The alternative — fetching full `OfferingDetail` on demand when the Edit dialog opens — was considered and rejected: it would need either a new Route Handler (permanently banned, §5) or a new *read* Server Action (not anticipated by any spec's action-file list, and this phase's whole action surface is deliberately enumerated as mutation-only), and it would cost the dialog a network round-trip before it could render prefilled fields at all, unlike Create's (and, with this fix, Edit's) instant-open behavior. Threading one more already-existing column through an already-open read-model seam is strictly less new surface than either alternative.

### 2.4 `editOfferingFieldsSchema` — the UI-facing companion schema, `.omit`-derived, same file as `updateOfferingSchema`

`saveAsNew` is required on `updateOfferingSchema` (pm13: "not `.default(false)`... there is no ambiguous 'caller forgot to say' case to paper over") but it is never a field the user directly toggles in this form — it's implied by *which button* they click (§2.6), not typed or checked. So `OfferingForm`'s edit-mode `useForm` can't validate against `updateOfferingSchema` directly (there's no `saveAsNew` input to produce a value for). This is the exact shape of gap `editUserDetailsFieldsSchema = updateUserDetailsSchema.omit({ userId: true })` and `editRoleFieldsSchema` (`update-role.schema.ts`) already solve for their own non-form field (there, an id; here, a routing flag) — same fix, same place: a derived, `.omit`-based companion schema added to `validation/product/update-offering.schema.ts` (pm13's file) by *this* unit, not pm13 itself, exactly as `editUserDetailsFieldsSchema` was added to `update-user-details.schema.ts` by the UI unit that built `UserForm`'s edit mode, not the backend unit that built `updateUserDetailsSchema`. This is additive to pm13's file (its four existing fields and their per-field rules are untouched) — the same "extend, don't restructure, an already-shipped file" discipline pm18 (`findList`'s `SELECT`) and pm19 (the guardrail's action-file array) both already used for their own one-line additions to someone else's file.

```ts
export const editOfferingFieldsSchema = updateOfferingSchema.omit({
  saveAsNew: true,
});
export type EditOfferingFields = z.infer<typeof editOfferingFieldsSchema>;
```

Unlike `editUserDetailsFieldsSchema` (which needs the `z.input`/`z.output` generic split because `userPhonenum` uses `.nullish().transform(...)`), `editOfferingFieldsSchema`'s three fields (`name`/`isSellable`/`billingOnly`) have no transforms — `useForm<EditOfferingFields>` needs only the one generic, the same simplification `pm19`'s `CreateOfferingForm` already uses for `CreateOfferingInput`.

### 2.5 Why this form can't have one native "the" submit action — and the fix

Every existing two-mode form in this codebase (`RoleForm`, `UserForm`) has exactly one submit outcome per mode: fill in fields, click one button (or press Enter), one thing happens. Edit offering doesn't fit that shape — a `DRAFT` target has **two** meaningfully different, equally valid save outcomes for the identical set of field values (update this row, or clone into a sibling), and an `ACTIVE` target has exactly one, but it's never "plain save." A single `<form onSubmit={handleSubmit(onSubmit)}>` wired to one native submit event can't express "which of two outcomes did the user mean" after the fact without inspecting which button fired the submit — solvable via the DOM's `SubmitEvent.submitter`, but that's an extra layer of native-event plumbing to keep working correctly across browsers and `jsdom`-based tests for a distinction React Hook Form can express directly and far more legibly: **call `handleSubmit` twice, once per outcome, each with the intended `saveAsNew` value already baked in via closure, and call whichever one the clicked button's `onClick` invokes.** Concretely:

```ts
const submitInPlace = handleSubmit((values) => onSubmit({ ...values, saveAsNew: false }));
const submitAsNewDraft = handleSubmit((values) => onSubmit({ ...values, saveAsNew: true }));
```

`handleSubmit(fn)` returns a plain `(event?) => Promise<void>` — React Hook Form supports calling it with no event at all for a fully programmatic submit (exactly how a `<button onClick={handleSubmit(onSubmit)}>` binding works anywhere else in this codebase; here it's just two separately-parameterized instances of that same call instead of one). The `<form>` element's own `onSubmit` is neutralized (`e.preventDefault()`, does nothing else) rather than routed to either variant — Enter-to-submit has no single unambiguous default action to fall back to here (unlike `RoleForm`/`UserForm`/`CreateOfferingForm`, each of which has exactly one submit outcome to map Enter to), so this form requires an explicit button click for every save path, on both `DRAFT` and `ACTIVE` targets. Every button that triggers a save is `type="button"`, never `type="submit"` — there is no button anywhere on this form using the `form="offering-form-edit"` cross-boundary attribute trick `CreateOfferingDialog`'s footer uses, because this form's own footer lives inside its own file (§2.6), not across a dialog/form file boundary.

### 2.6 Footer lives inside `EditOfferingForm` itself — a flagged departure from Create's convention

`CreateOfferingForm` renders only fields; `CreateOfferingDialog` renders the `DialogFooter` (Cancel + one "Save offering" button bound via `form=`) as a sibling. Edit's footer needs a different button set depending on `currentStatus` — Cancel + "Save as new draft" + "Save" on `DRAFT`; Cancel + "Create new draft" only on `ACTIVE`, no plain Save at all (build plan's own literal words) — and per §2.5, the buttons that trigger a save must live wherever `handleSubmit`'s closure is in scope, which is inside `OfferingForm`'s own file, not the wrapping table component. So `EditOfferingForm` renders its own `DialogFooter` (same component, same visual output, just authored one file over from where Create's lives) immediately after its `FieldGroup`, and the inline dialog wiring in `manage-offering-table.tsx` (§2.1) renders no `DialogFooter` of its own for Edit at all. This is called out explicitly so a reviewer doesn't read the missing sibling `DialogFooter` in the table file as an oversight relative to `CreateOfferingDialog`'s shape — it's a direct, necessary consequence of §2.5's design, not an inconsistency.

Button set by `currentStatus` (exact mockup copy, `mockup-product_module_manage_products.html`'s `openModal('edit', ...)` cases):

| `currentStatus` | Buttons (left to right) | Clicking... |
|---|---|---|
| `DRAFT` | Cancel · "Save as new draft" (outline) · "Save" (default) | Cancel → `onCancel()`. "Save as new draft" → `submitAsNewDraft()`. "Save" → `submitInPlace()`. |
| `ACTIVE` | Cancel · "Create new draft" (default) | Cancel → `onCancel()`. "Create new draft" → `submitAsNewDraft()` (same function as `DRAFT`'s "Save as new draft" — the branch path is identical regardless of which button triggered it; only the button's own label differs by status, per `pm13`'s routing table treating `saveAsNew` as ignored/irrelevant on an `ACTIVE` target). |

All buttons disable while `isSubmitting`; the spinner (`Loader2`, matching `CreateOfferingDialog`'s convention) renders on every visible save button while `isSubmitting` is true, not only the one actually clicked — an accepted simplification, since exactly one save can be in flight at a time and the whole dialog is non-interactive during it (tracking *which* button was clicked purely to spinner only that one isn't worth a second piece of state for a fully-blocked modal).

### 2.7 The `--bg-warning` banner — exact copy, exact condition

Rendered inside `EditOfferingForm`, above the field group, **only** when `currentStatus === "ACTIVE"` (never on `DRAFT` — `prodmgmt-ui-context-phase2.md`'s own wording: "whenever the target offering's current status is `ACTIVE` (never on a `DRAFT` target)"):

> `<Name>` is active. Saving will not change it — a new draft version is created instead.

`--bg-warning` background, `--text-warning` text, `--radius` corners, no icon (ui-context-phase2: "the copy itself is the signal") — reusing the exact tint pairing already defined, not inventing a new one. `<Name>` is `editingRow.row.name`, threaded in as the `offeringName` prop (not re-derived from `defaultValues.name`, since `defaultValues.name` is the *editable* field value and could differ from the row's original name mid-edit before save — the banner names the offering being edited, not whatever the user is currently typing).

### 2.8 `currentStatus` is narrowed to `"DRAFT" | "ACTIVE"`, defensively, matching pm13's own defense-in-depth

`pm18`'s row-action matrix never renders an Edit button on a `RETIRED` row, so `editingRow.row.lifecycleStatus` is `"DRAFT"` or `"ACTIVE"` by construction at every real call site — but `OfferingFormEditProps.currentStatus` is still typed as the narrow union `"DRAFT" | "ACTIVE"`, not the full `LifecycleStatus`, the same "the UI shouldn't even be able to represent an unreachable case" discipline `pm13-spec`'s own `OFFERING_RETIRED` guard applies one layer down, in the service. If a future caller somehow reaches this component with a `RETIRED` row, `as "DRAFT" | "ACTIVE"` at the one call site in `manage-offering-table.tsx` is a deliberate, narrow cast rather than a runtime branch — the service-layer guard (pm13) is the real backstop; this is UI-level self-documentation, not a second enforcement point.

### 2.9 Success handling — copy differs by outcome, and a branched edit auto-expands its family

Mirrors `pm19`'s `router.refresh()`-not-`router.push()` reasoning exactly (no URL-selected-row concept on this page) — on `result.ok`, the dialog closes and `router.refresh()` re-runs `page.tsx`'s `fetchAllOfferingRows`/`groupIntoFamilies`, which is what makes the edited or newly-branched row show up in `ManageOfferingTable`'s next render. Two additional, outcome-specific things happen beyond that shared baseline:

- **Toast copy differs by `result.branched`:** `"Offering updated"` when `false` (an in-place `DRAFT` save, including the no-op case — pm13's no-op guard still returns `ok: true, branched: false`, and from the user's point of view nothing going wrong is still a successful save), `"New draft version created"` when `true` (either an `ACTIVE`-target edit or an explicit "Save as new draft").
- **A branched edit auto-expands its family.** The build plan's own visible-result line requires the new sibling be "visible as a new row in that family's expanded history" — taken literally, not just possible-to-see-if-the-user-happens-to-expand-it. Since `editingRow` already carries `familyId` (captured at the moment the Edit button was clicked, from the same `family.familyId` already in scope at that point in the render — no separate family-resolution helper needed, unlike `page.tsx`'s private `resolveFamilyId`, which this component never needs to duplicate), the success handler does `setExpandedFamilies((prev) => new Set(prev).add(editingRow.familyId))` whenever `result.branched` is `true`, so the new sibling is on-screen immediately after the dialog closes and the refresh completes, with no extra click required.

Failure handling mirrors `CreateOfferingDialog`'s branch-by-`code` shape, extended with pm13's two extra failure codes: `FORBIDDEN` → toast, dialog stays open; `VALIDATION_ERROR` → toast (shouldn't happen — the client's own `zodResolver` already blocks an invalid submit, same caveat `pm19-spec` notes for its own action); `OFFERING_RETIRED` → toast ("This offering has been retired and can no longer be edited."), dialog stays open — unreachable from this unit's own UI (§2.8) but handled rather than crashing, matching pm13's own "guard it anyway" defensive stance; `OFFERING_NOT_FOUND` → toast plus close the dialog and `router.refresh()` immediately (unlike the other failure branches, staying open on a row that no longer exists would just let the user resubmit into the same dead end) — a genuinely reachable case if another admin discarded/retired-and-something-removed the row in another session between page load and this submit (not currently possible via any shipped mutation, since discard/retire never hard-delete, but the service's own guard exists for a reason and the UI should degrade gracefully rather than assume it's unreachable); `SERVER_ERROR` and a thrown exception both → generic retry toast, dialog stays open.

### 2.10 What this unit explicitly does NOT do

- No changes to `Add price`/`Activate`/`Discard`/`Retire` seams — those stay exactly as `pm18` left them (inert, own seam comments), reserved for pm21–pm23.
- No change to `CreateOfferingForm`/`CreateOfferingDialog`'s own behavior, copy, or files — this unit only adds a sibling mode to the union, it does not touch the create path.
- No new dialog *file* (§2.1) and no new audit event type — `PRODUCT_OFFERING_UPDATED`/`PRODUCT_OFFERING_BRANCHED` both already exist (pm13); this unit's action only calls the existing service.
- No specification or price fields on this dialog — unchanged scope from Create (pm21/pm22 add those, reached from the row's own separate actions).
- No change to `app/(app)/products/manage-products/page.tsx` itself beyond what's already needed for `billingOnly` to flow through (§2.3) — the page's own fetch/group logic is otherwise untouched.

## 3. Implementation

### 3.1 Validation — `validation/product/update-offering.schema.ts` (edit — one companion export appended)

```ts
// ...existing updateOfferingSchema / UpdateOfferingInput, unchanged (pm13)...

// pm20-spec §2.4/§3.1. UI-facing companion: the exact fields
// `OfferingForm`'s edit mode renders and validates client-side. `saveAsNew`
// is deliberately omitted — it's never a form field, only ever implied by
// which footer button was clicked (Design §2.5/§2.6). Mirrors
// `editUserDetailsFieldsSchema` / `editRoleFieldsSchema`'s own
// same-file, `.omit`-derived shape.
export const editOfferingFieldsSchema = updateOfferingSchema.omit({
  saveAsNew: true,
});
export type EditOfferingFields = z.infer<typeof editOfferingFieldsSchema>;
```

No other line in this file changes — `updateOfferingSchema`'s four fields and their rules are pm13's, untouched.

### 3.2 Read model — `types/product.ts` (edit — one field added)

```ts
export type OfferingListRow = {
  productOfferingId: string;
  name: string;
  lifecycleStatus: LifecycleStatus;
  version: number;
  isSellable: boolean;
  lastModified: Date;
  familyOfferingId: string | null; // pm18 §2.2
  billingOnly: boolean; // new (pm20 §2.3) — needed to prefill the Edit dialog
};
```

### 3.3 Repository — `db/repositories/product-offering.ts` (edit — one field added to `findList`'s `SELECT`)

```ts
const rows = await db
  .select({
    productOfferingId: productOffering.productOfferingId,
    name: productOffering.name,
    lifecycleStatus: productOffering.lifecycleStatus,
    version: productOffering.version,
    isSellable: productOffering.isSellable,
    lastModified: productOffering.lastModified,
    familyOfferingId: productOffering.familyOfferingId, // pm18
    billingOnly: productOffering.billingOnly, // new (pm20)
  })
  .from(productOffering)
  // ...unchanged WHERE/ORDER BY/LIMIT/OFFSET
```

No other line in `findList` changes; `findDetailById`, `insertOffering`, `branchOfferingAsDraft` are untouched. `services/product/list-offerings.ts` needs no edit — same "the field flows through because the repository call underneath it does" reasoning `pm18-spec` §3.3 already used for `familyOfferingId`.

### 3.4 Server Action — `actions/product/update-offering.action.ts` (new)

```ts
"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { updateOffering } from "@/services/product/update-offering";
import { updateOfferingSchema } from "@/validation/product/update-offering.schema";

export type UpdateOfferingActionResult =
  | { ok: true; offeringId: string; branched: boolean }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm20-spec §3.4. `offeringId` travels as its own parameter, never inside
// `rawInput` (Design §2.2) — mirrors `updateOffering`'s own shape (pm13).
export async function updateOfferingAction(
  offeringId: string,
  rawInput: unknown,
): Promise<UpdateOfferingActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = updateOfferingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await updateOffering(offeringId, parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  // Both product pages, matching create-offering.action.ts's precedent
  // (pm19-spec §3.2) — Manage Products shows the updated/branched row
  // directly; View Product's own queries are invalidated too, relevant once
  // a branched sibling is later activated.
  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return { ok: true, offeringId: result.offeringId, branched: result.branched };
}
```

### 3.5 Form — `components/products/manage/offering-form.tsx` (edit — add the edit mode)

```tsx
"use client";

import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  createOfferingSchema,
  type CreateOfferingInput,
} from "@/validation/product/create-offering.schema";
import {
  editOfferingFieldsSchema,
  type EditOfferingFields,
  type UpdateOfferingInput,
} from "@/validation/product/update-offering.schema";

type OfferingFormCreateProps = {
  mode: "create";
  onSubmit: (values: CreateOfferingInput) => Promise<void>;
  isSubmitting: boolean;
};

// pm20-spec §3.5. currentStatus is the narrow union, never the full
// LifecycleStatus (Design §2.8) — RETIRED rows never reach this component
// via any shipped Edit seam.
type OfferingFormEditProps = {
  mode: "edit";
  offeringName: string;
  currentStatus: "DRAFT" | "ACTIVE";
  defaultValues: { name: string; isSellable: boolean; billingOnly: boolean };
  onSubmit: (values: UpdateOfferingInput) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
};

export type OfferingFormProps = OfferingFormCreateProps | OfferingFormEditProps;

export function OfferingForm(props: OfferingFormProps): React.JSX.Element {
  if (props.mode === "edit") {
    return <EditOfferingForm {...props} />;
  }
  return <CreateOfferingForm {...props} />;
}

// pm20-spec §2.5–§2.7. Two independent `handleSubmit` calls, one per save
// outcome, instead of one native form submit disambiguated after the fact
// — see Design §2.5 for why. Renders its own DialogFooter (Design §2.6),
// unlike CreateOfferingForm, whose footer lives one file over in
// CreateOfferingDialog.
function EditOfferingForm({
  offeringName,
  currentStatus,
  defaultValues,
  onSubmit,
  onCancel,
  isSubmitting,
}: OfferingFormEditProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
  } = useForm<EditOfferingFields>({
    resolver: zodResolver(editOfferingFieldsSchema),
    defaultValues,
  });

  // Keeps the form in sync if a different row is opened into this same
  // dialog instance while it's mounted — mirrors RoleForm/UserForm's own
  // edit-mode effect.
  useEffect(() => {
    reset(defaultValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValues.name, defaultValues.isSellable, defaultValues.billingOnly]);

  const submitInPlace = handleSubmit((values) =>
    onSubmit({ ...values, saveAsNew: false }),
  );
  const submitAsNewDraft = handleSubmit((values) =>
    onSubmit({ ...values, saveAsNew: true }),
  );

  return (
    <form
      id="offering-form-edit"
      noValidate
      onSubmit={(e) => e.preventDefault()} // Design §2.5 — no single default submit
    >
      {currentStatus === "ACTIVE" && (
        <div className="mb-3 rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
          {offeringName} is active. Saving will not change it — a new draft
          version is created instead.
        </div>
      )}

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="edit-name">Name</FieldLabel>
          <Input
            id="edit-name"
            type="text"
            autoComplete="off"
            autoFocus
            aria-invalid={!!errors.name}
            disabled={isSubmitting}
            {...register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>

        {/* No isBundle control here, ever — code-standards-phase2 §1 rule 9. */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body-sm font-medium text-foreground">
            Options
          </legend>

          <Controller
            control={control}
            name="isSellable"
            render={({ field }) => (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={field.value}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    field.onChange(checked === true)
                  }
                />
                Sellable
              </label>
            )}
          />

          <Controller
            control={control}
            name="billingOnly"
            render={({ field }) => (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={field.value}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    field.onChange(checked === true)
                  }
                />
                Billing only
              </label>
            )}
          />
        </fieldset>
      </FieldGroup>

      <DialogFooter className="mt-4">
        <Button
          type="button"
          variant="ghost"
          disabled={isSubmitting}
          onClick={onCancel}
        >
          Cancel
        </Button>

        {currentStatus === "DRAFT" && (
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => void submitAsNewDraft()}
          >
            {isSubmitting && <Loader2 className="animate-spin" />}
            Save as new draft
          </Button>
        )}

        <Button
          type="button"
          disabled={isSubmitting}
          onClick={() =>
            void (currentStatus === "ACTIVE"
              ? submitAsNewDraft()
              : submitInPlace())
          }
        >
          {isSubmitting && <Loader2 className="animate-spin" />}
          {currentStatus === "ACTIVE" ? "Create new draft" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// CreateOfferingForm — unchanged from pm19-spec §3.3, reproduced here only
// to show it is untouched by this unit's diff.
function CreateOfferingForm({
  onSubmit,
  isSubmitting,
}: OfferingFormCreateProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<CreateOfferingInput>({
    resolver: zodResolver(createOfferingSchema),
    defaultValues: { name: "", isSellable: true, billingOnly: false },
  });

  return (
    <form
      id="offering-form-create"
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
    >
      {/* ...unchanged, see pm19-spec §3.3... */}
    </form>
  );
}
```

### 3.6 Filling the pm18 seams — `components/products/manage/manage-offering-table.tsx` (edit)

Add local state (alongside the existing `expandedFamilies` state pm18 shipped):

```ts
const router = useRouter();
const [editingRow, setEditingRow] = useState<{
  row: OfferingListRow;
  familyId: string;
} | null>(null);
const [isEditSubmitting, setIsEditSubmitting] = useState(false);

function handleEditOpenChange(open: boolean): void {
  if (isEditSubmitting) return;
  if (!open) setEditingRow(null);
}

async function handleEditSubmit(values: UpdateOfferingInput): Promise<void> {
  if (!editingRow) return;
  setIsEditSubmitting(true);
  try {
    const result = await updateOfferingAction(
      editingRow.row.productOfferingId,
      values,
    );
    if (result.ok) {
      const branched = result.branched;
      setEditingRow(null);
      if (branched) {
        toast.success("New draft version created");
        // Design §2.9 — make the new sibling visible without an extra click.
        setExpandedFamilies((prev) => new Set(prev).add(editingRow.familyId));
      } else {
        toast.success("Offering updated");
      }
      router.refresh();
    } else if (result.code === "FORBIDDEN") {
      toast.error("You don't have permission to do that.");
    } else if (result.code === "OFFERING_RETIRED") {
      toast.error(
        "This offering has been retired and can no longer be edited.",
      );
    } else if (result.code === "OFFERING_NOT_FOUND") {
      toast.error("This offering no longer exists. Refreshing...");
      setEditingRow(null);
      router.refresh();
    } else {
      toast.error("Something went wrong. Please try again.");
    }
  } catch {
    toast.error("Something went wrong. Please try again.");
  } finally {
    setIsEditSubmitting(false);
  }
}
```

Locate each Edit button pm18 left inert (both on a family's primary row and on every expanded sibling row — `pm18-spec` §3.7 point 5), remove its seam comment, and wire its `onClick`:

```tsx
// Before (pm18), rendered once per row (primary and expanded siblings alike):
<button
  type="button"
  aria-label={`Edit ${row.name}`}
  className="..."
>
  <Pencil size={16} aria-hidden />
</button>
{/* pm20 seam: onClick opens OfferingForm in edit mode */}

// After (pm20) — `family` is the enclosing OfferingFamilyRow already in
// scope at this point in the per-family render (Design §2.9: no separate
// family-id resolution needed):
<button
  type="button"
  aria-label={`Edit ${row.name}`}
  className="..."
  onClick={() =>
    setEditingRow({ row, familyId: family.familyId })
  }
>
  <Pencil size={16} aria-hidden />
</button>
```

Render the one shared dialog (near the end of the component's JSX, a sibling of the table markup, not per-row):

```tsx
{editingRow && (
  <Dialog open onOpenChange={handleEditOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {editingRow.row.lifecycleStatus === "ACTIVE"
            ? "Edit — creates new draft"
            : "Edit draft"}
        </DialogTitle>
      </DialogHeader>

      <OfferingForm
        mode="edit"
        offeringName={editingRow.row.name}
        currentStatus={editingRow.row.lifecycleStatus as "DRAFT" | "ACTIVE"}
        defaultValues={{
          name: editingRow.row.name,
          isSellable: editingRow.row.isSellable,
          billingOnly: editingRow.row.billingOnly,
        }}
        onSubmit={handleEditSubmit}
        onCancel={() => handleEditOpenChange(false)}
        isSubmitting={isEditSubmitting}
      />
    </DialogContent>
  </Dialog>
)}
```

Conditionally mounting the dialog only while `editingRow !== null` (rather than always rendering with `open={editingRow !== null}`, the way `CreateOfferingDialog` stays permanently mounted) means it loses Radix's close-transition animation — an accepted, minor cosmetic trade-off, not worth threading a second "last edited row, kept around after close for the exit animation" state through for.

New imports needed: `useRouter` (`next/navigation`), `toast` (`sonner`), `updateOfferingAction`, `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle` (`@/components/ui/dialog`), and a type-only import of `UpdateOfferingInput`. `OfferingForm` is already imported by this file (pm19). No other line in this file changes — the `Add price`/`Activate`/`Discard`/`Retire` seams, and the "New offering" CTA wiring pm19 already filled, stay byte-unchanged.

### 3.7 Guardrail test — `tests/guardrails/product-module-boundaries.test.ts` (edit — one array entry appended)

```ts
// pm19 shipped this array with one entry; pm20 appends its own, per
// pm19-spec §2.5/§3.6's own instruction ("pm20–pm23 each append their own
// action file to this array as it lands").
const EXPECTED_PRODUCT_ACTION_FILES = [
  "create-offering.action.ts",
  "update-offering.action.ts",
];
```

No other assertion in this file changes.

### 3.8 Tests

- `tests/actions/update-offering.action.test.ts` (new) — mirrors `create-offering.action.test.ts`'s structure: mocks `requirePermission`, `updateOffering`, and `next/cache`'s `revalidatePath`; asserts a successful call invokes `updateOffering` with `(offeringId, parsedData, actorId)` and returns `{ ok: true, offeringId, branched }` matching whatever the mocked service returned, and calls `revalidatePath` with both product pages; asserts an empty `name` returns `VALIDATION_ERROR` with `fieldErrors.name` populated and never calls `updateOffering`; asserts a redirect from `requirePermission` returns `FORBIDDEN`; asserts the service's `{ ok: false, code: "OFFERING_NOT_FOUND" }` and `{ ok: false, code: "OFFERING_RETIRED" }` both pass through unchanged; asserts a thrown error from the service returns `SERVER_ERROR`.
- `tests/components/manage-offering-table.test.tsx` (**edit**, pm18/pm19-owned file) — this file's Edit-button assertion currently asserts "no attached behavior" alongside every other row action (pm18-spec §3.9). Update it, and only it: clicking Edit on a `DRAFT` row (primary or an expanded sibling) opens a dialog titled "Edit draft" with Name/Sellable/Billing-only prefilled from that row, no warning banner, and exactly three footer buttons — Cancel, "Save as new draft," "Save"; clicking Edit on an `ACTIVE` row opens a dialog titled "Edit — creates new draft" with the `--bg-warning` banner naming that row and exactly two footer buttons — Cancel, "Create new draft" (no "Save" anywhere in the DOM for this case); submitting each path (mock `updateOfferingAction`) asserts the exact `saveAsNew` value sent for each of the three buttons (`false` for "Save," `true` for both "Save as new draft" and "Create new draft"); a successful `branched: true` result asserts the family's `expandedFamilies` set gains that family's id (its other version rows become visible without a further click) and the "New draft version created" toast fires; a successful `branched: false` result asserts the "Offering updated" toast fires and no expand-state change occurs. Leave every other seam's ("Add price"/"Activate"/"Discard"/"Retire") "no attached behavior" assertion untouched — those remain real seams for pm21–pm23.
- `tests/guardrails/product-module-boundaries.test.ts` — run the full suite; confirm the appended array entry (§3.7) passes and no other assertion regresses.

### 3.9 Commit

One commit. Contents: `validation/product/update-offering.schema.ts` (edit — one companion export appended), `types/product.ts` (edit — `billingOnly` added to `OfferingListRow`), `db/repositories/product-offering.ts` (edit — one field added to `findList`'s `SELECT` only), `actions/product/update-offering.action.ts` (new), `components/products/manage/offering-form.tsx` (edit — edit mode added, create mode untouched), `components/products/manage/manage-offering-table.tsx` (edit — Edit seams filled, one dialog added, other seams untouched), `tests/guardrails/product-module-boundaries.test.ts` (edit — one array entry appended), `tests/actions/update-offering.action.test.ts` (new), `tests/components/manage-offering-table.test.tsx` (edit — Edit-seam assertions replaced, others untouched). Explicitly **not** in this commit: any change to `services/product/update-offering.ts` or `db/repositories/product-offering.ts`'s `updateOfferingDraftInPlace`/`branchOfferingAsDraft` (pm13/pm12's own code, consumed here unmodified), any `db/migrations/` file, any change to `create-offering.action.ts`/`create-offering-dialog.tsx`, any change to `app/(app)/products/manage-products/page.tsx` beyond what `billingOnly` flowing through already covers.

## 4. Dependencies

**No new npm packages.** Everything this unit needs is already installed and already used elsewhere in this codebase: `react-hook-form` + `@hookform/resolvers/zod` (`role-form.tsx`, `user-form.tsx`, and this unit's own `CreateOfferingForm`); `lucide-react`'s `Loader2` (already used by `create-offering-dialog.tsx`) and `Pencil` (already imported by `manage-offering-table.tsx`, pm18); `sonner`'s `toast` (`create-offering-dialog.tsx`); `components/ui/dialog.tsx`, `components/ui/checkbox.tsx`, `components/ui/input.tsx`, `components/ui/field.tsx`, `components/ui/button.tsx` — all existing primitives, no new one added; `next/navigation`'s `useRouter` (already used by `create-offering-dialog.tsx`). No Zod, Drizzle, or Postgres-driver change — this unit adds one derived Zod schema (an `.omit()` of an existing one) and one already-existing DB column exposed through an already-existing `SELECT`, not a new validation shape or a new column.

## 5. Verification checklist

**Diff hygiene**
- [ ] `git status` shows only the files listed in §3.9 — nothing under `services/product/update-offering.ts`, `db/migrations/`, `db/schema/`, `actions/product/create-offering.action.ts`, or `app/(app)/products/manage-products/page.tsx` (beyond the `billingOnly` column flowing through, which touches no line of `page.tsx` itself).
- [ ] `validation/product/update-offering.schema.ts`'s diff is exactly the `editOfferingFieldsSchema`/`EditOfferingFields` addition — `updateOfferingSchema`'s four fields and their rules are byte-identical to pm13's version.
- [ ] `db/repositories/product-offering.ts`'s diff (beyond pm18's own `familyOfferingId` line, already landed) is exactly one added `billingOnly` line inside `findList`'s `SELECT` — `findDetailById`, `insertOffering`, `branchOfferingAsDraft`, `updateOfferingDraftInPlace` byte-identical to before this unit.
- [ ] `offering-form.tsx`'s `CreateOfferingForm` function and its rendered output are byte-identical to pm19's version — grep/diff confirms no incidental change crept in while adding the edit mode.
- [ ] No `isBundle` key anywhere in `EditOfferingFields`, `editOfferingFieldsSchema`, or `EditOfferingForm`'s rendered fields — grep confirms.
- [ ] `update-offering.action.ts` contains no direct DB/repository import — it calls only `services/product/update-offering`.
- [ ] No new file named `edit-offering-dialog.tsx` (or similar) exists anywhere in `components/products/manage/` — confirms Design §2.1's resolution was actually followed, not silently reverted to a separate-file shape during implementation.

**Backend/Action correctness**
- [ ] An unpermitted caller invoking `updateOfferingAction` gets `{ ok: false, code: "FORBIDDEN" }` and `updateOffering` is never called.
- [ ] A `products:EDIT` caller submitting a valid edit against a `DRAFT` offering with `saveAsNew: false` gets `{ ok: true, offeringId: <same id>, branched: false }`, and both `revalidatePath` calls fire.
- [ ] The same caller submitting against an `ACTIVE` offering gets `{ ok: true, offeringId: <new sibling id>, branched: true }`.
- [ ] `saveAsNew: true` against a `DRAFT` gets `{ ok: true, offeringId: <new sibling id>, branched: true }`.
- [ ] An empty `name` returns `VALIDATION_ERROR` with `fieldErrors.name` populated; `updateOffering` is never called.
- [ ] The service's `OFFERING_NOT_FOUND`/`OFFERING_RETIRED` codes pass through the action unchanged.
- [ ] A thrown error from the service returns `SERVER_ERROR`, not an unhandled exception.

**UI behavior — the point of the unit**
- [ ] Clicking Edit on any `DRAFT` row (a family's primary row, and independently, one of its expanded sibling rows) opens a dialog titled "Edit draft," prefilled with that exact row's `name`/`isSellable`/`billingOnly`, no warning banner, three footer buttons: Cancel, "Save as new draft," "Save."
- [ ] Clicking Edit on any `ACTIVE` row opens a dialog titled "Edit — creates new draft," the same three fields prefilled, the `--bg-warning` banner naming that row, and exactly two footer buttons: Cancel, "Create new draft" — no "Save" button anywhere in this dialog's DOM.
- [ ] No Edit button renders at all on a `RETIRED` row (pm18's own matrix, re-confirmed still true after this unit's changes).
- [ ] Clicking "Save" on a `DRAFT` edit updates that same row in place: after the dialog closes, the table (without a manual reload) shows the updated `name`/flags on that same row, its `version` unchanged, a "Offering updated" toast fires, and the family's expand state is unchanged.
- [ ] Clicking "Save as new draft" on a `DRAFT`, or "Create new draft" on an `ACTIVE` row, produces a new sibling row: the family in question auto-expands (or was already expanded) so the new `DRAFT` sibling is visible immediately, a "New draft version created" toast fires, and the original row (the `DRAFT` that was "saved as new," or the `ACTIVE` row that was edited) is confirmed unchanged — same name/flags/version as before the edit.
- [ ] Saving a `DRAFT` with no actual field changes ("Save," not "Save as new draft") still closes the dialog and shows "Offering updated" (pm13's no-op guard — no error, no new row).
- [ ] Cancel closes the dialog with no request sent and no row changed, from both the `DRAFT` and `ACTIVE` variants.
- [ ] The dialog cannot be dismissed (Cancel, overlay click, or Escape) while a submission is in flight.
- [ ] A real `PRODUCT_OFFERING_UPDATED` audit row is written for an in-place save, and a real `PRODUCT_OFFERING_BRANCHED` audit row (with `before_data.sourceOfferingId`/`after_data.sourceOfferingId` both set) is written for every branch-producing save — confirms pm13's service is genuinely invoked end-to-end, not just its type signature.

**Guardrail suite**
- [ ] `tests/guardrails/product-module-boundaries.test.ts`'s appended assertion (§3.7) passes: `actions/product/` contains exactly `create-offering.action.ts` and `update-offering.action.ts`.
- [ ] Every other guardrail assertion in that file still passes unmodified.
- [ ] `tests/components/manage-offering-table.test.tsx`'s updated Edit-seam assertions (§3.8) pass; its `Add price`/`Activate`/`Discard`/`Retire` "no behavior yet" assertions still pass unmodified.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm run test` green — full suite, including the new/edited test files above.
- [ ] `npm run build` passes.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy) gets a pm20 entry with the commit reference, and explicitly records the two design calls a future unit (pm21–pm23) might otherwise re-litigate: no separate `edit-offering-dialog.tsx` file (Design §2.1), and `billingOnly` now flows through `OfferingListRow`/`findList` (Design §2.3) — so pm21/pm22 don't independently reach for either pattern under a different name.

**Pipeline**
- [ ] CI green end-to-end. This unit adds one action file to an already-established mutation surface (pm19's `create-offering.action.ts` was the first); the SAST/DAST baseline should show no new finding beyond what's already expected for a standard Server-Action-backed edit form.

Any failing item means the unit is not done. Units pm21–pm23 each follow the same dialog/form/action/guardrail-increment shape pm19 established and this unit continued — do not start any of them assuming a different pattern, and in particular do not reintroduce a per-feature dialog *file* for any seam whose footer needs more than one submit outcome without first checking whether that seam actually needs one (Add price and the lifecycle actions each have exactly one submit outcome per pm99's own contract, so §2.5's multi-outcome problem is specific to Edit and should not be copied reflexively).
