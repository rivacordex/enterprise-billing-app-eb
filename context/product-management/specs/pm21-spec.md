# PM21 — UI: Specification Management

- **Unit:** 21 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm14 (`addSpecification`/`updateSpecification`/`deleteSpecification` services this unit calls — their exact `{ ok, offeringId, productSpecId, branched }` result shape and branch-first routing drive this unit's dialog/copy logic directly) and Unit pm18 (the row-action matrix inside `ManageOfferingTable` this unit adds a sixth action to, and the `expandedFamilies` state this unit's branch handling reuses).
- **Boundary, per the build plan's own words:** "Frontend UI + its Server Actions (merged)." This spec honors that boundary with two narrow, explicitly flagged exceptions — see Design §2.3 (a read-model gap this unit has to close, the same shape pm18 §2.2 and pm20 §2.3 already used for `familyOfferingId`/`billingOnly`) and Design §2.7 (one new binding component name added to `prodmgmt-code-standards-phase2.md` §4/§7 in this unit's own commit, per the increment convention `pm19-spec.md` §2.5 established).
- **Authorizing sections:** `prodmgmt-project-overview-phase2.md` "Specification management" ("Add and edit specifications on a `DRAFT`. On an `ACTIVE` offering, adding or editing a specification triggers the clone-to-new-draft behavior... Hard delete is available for a specification, but only on a `DRAFT` row") and Success Criteria ("Deleting a specification is only ever possible on a `DRAFT` row"); `prodmgmt-architecture-phase2.md` §6 Inv. 14 (editing an `ACTIVE` offering's specifications never mutates them in place); `prodmgmt-code-standards-phase2.md` §1 rule 10, §6 rule 12 ("by the time any spec-write function is called, its target offering is guaranteed `DRAFT`"), §4 (binding component names — `SpecificationForm` is named, no dialog wrapper is), §7 (file tree: `actions/product/create-specification.action.ts`, `update-specification.action.ts`, `delete-specification.action.ts`; `components/products/manage/specification-form.tsx`), §9 guardrail 10 ("Spec-delete unreachable on `ACTIVE`... asserted directly, not just trusted from construction"); `prodmgmt-ui-context-phase2.md`'s row-action icon/color table (five actions named, none reserved for specifications — this unit's gap to fill, see Design §2.2) and the "This creates a new draft" warning banner spec (reused unmodified); `pm99-build-plan-phase2.md` Unit pm21 (this unit's literal contract: "reached from the offering's detail/expansion surface... adding or editing a spec on a `DRAFT` applies directly... the same action against an `ACTIVE` offering produces a new draft version... delete is only ever offered on a `DRAFT`"); `pm14-spec.md` (the three services this unit calls — exact result shape, branch-first routing table, the disclosed fact that `deleteSpecification`'s branch-first path exists in the service layer but, per the build plan's own words for this unit, is never invoked by this unit's UI — see Design §2.8); `pm18-spec.md` §2.6/§3.7 (the row-action seam pattern and matrix this unit extends by one column) and §2.2 (the "read-model gap, closed by extending an existing exported function, flagged not assumed" precedent this unit's own §2.3 follows one layer further); `pm19-spec.md` §2.5 (the guardrail-increment-in-the-same-commit convention, and the "no new read Server Action — this phase's action surface is deliberately mutation-only" stance Design §2.3 has to reason past, for a materially different reason than pm20's); `pm20-spec.md` §2.9 (the `branched`-driven toast-copy/auto-expand pattern this unit reuses verbatim) and §2.4/§2.5 (the "footer lives wherever the submit closure is" and "single dialog, no dialog-per-seam" reasoning this unit weighs against, and departs from, in Design §2.4); `components/roles/delete-role-dialog.tsx` (the one real, shipped `AlertDialog`-based hard-delete confirmation precedent in this codebase — reused near-verbatim for spec delete, see Design §2.4 and Implementation §3.4); `services/product/get-offering-detail.ts` (the existing, unmodified read service this unit reuses to close the read-model gap, see Design §2.3); `validation/product/product-spec-characteristics.schema.ts` (`z.record(z.string().min(1), z.string())` — the flat string record this unit is the first to build a create/edit UI for, see Design §2.6).

- **Codebase state verified 2026-07-22 (re-verify before implementing):**
  - **Shipped:** Unit pm10 (`family_offering_id` column), Unit pm11 (`createOffering`), Unit pm12 (`branchOfferingAsDraft`).
  - **Not yet shipped as of this writing:** Units pm13 (`updateOffering`), pm14 (`addSpecification`/`updateSpecification`/`deleteSpecification`, and the write methods on `product-specification.ts`), pm15/pm16 (price/lifecycle services), pm17 (nav split), pm18 (`app/(app)/products/manage-products/` doesn't exist), pm19 (`OfferingForm`/`CreateOfferingDialog`), pm20 (`OfferingForm`'s edit mode, `billingOnly` on `OfferingListRow`). **This spec is written assuming pm14 and pm18 (and, for the shared table state this unit extends, pm19/pm20) will all exist exactly as their own specs describe by the time this unit's implementation lands** — the same "spec written ahead of its dependency's actual shipping" stance those units' own specs took. Before starting, re-confirm concretely: `services/product/add-specification.ts`/`update-specification.ts`/`delete-specification.ts` export the exact result shapes pm14-spec §2 describes; `components/products/manage/manage-offering-table.tsx` exists, already has `editingRow`/`expandedFamilies` state (pm20) and a five-action row matrix (pm18); `types/product.ts`'s `SpecificationCard` is `{ productSpecId, name, isMandatory, isDefault, defaultValue, characteristics }` (confirmed live in the real repo today, Phase 1 shape, unchanged by any Phase 2 unit so far).
  - `services/product/get-offering-detail.ts` exists today, shipped in Phase 1, exporting `getOfferingDetail(productOfferingId: string, now?: Date): Promise<OfferingDetail | null>` where `OfferingDetail.specifications: SpecificationCard[]`. This unit reuses it unmodified — see Design §2.3.
  - `components/ui/alert-dialog.tsx` (a `radix-ui` `AlertDialog` wrapper: `AlertDialog`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogCancel`) and `components/roles/delete-role-dialog.tsx` (a full, shipped usage of it) both exist today — confirmed live in the real repo. This is the exact pattern Design §2.4/Implementation §3.4 reuse for specification delete.
  - No dynamic key/value list-editing UI pattern (`useFieldArray` or otherwise) exists anywhere in this codebase as of this writing — confirmed by inspection of every existing form (`role-form.tsx`, `user-form.tsx`, and pm19/pm20's `offering-form.tsx`), all of which are fixed-field forms. This unit is the first to need one — see Design §2.6.

---

## 1. Goal

Let a `products:EDIT` user click a "Specifications" action on any offering row (a family's primary row or an expanded sibling version) on `/products/manage-products`, and from a single dialog view, add and edit that offering's specifications — including its free-form characteristics as key/value pairs — and hard-delete a specification, with the effect depending on the target row's own current status exactly as the build plan states: a `DRAFT` target's writes apply directly and are visible in the same dialog immediately; the same write against an `ACTIVE` target transparently produces a new sibling `DRAFT` version carrying the change, closes the dialog, and leaves the `ACTIVE` row's own specifications untouched; delete is never offered at all except on a `DRAFT` row.

## 2. Design

**Why this unit is UI + Server Actions merged, not split:** identical reasoning to `pm19-spec` §2 — three `actions/product/*.action.ts` files with no caller, and a dialog with no working action behind it, are each individually unverifiable as "done." Only together do they produce this unit's one demoable result: click "Specifications," add one, see it persisted and (on a `DRAFT`) reflected in the same open dialog.

### 2.1 `offeringId`/`specId` are function parameters, never schema fields — continued from pm13/pm14

`pm14-spec` Design already settled this for the service layer: `updateSpecification(specId, offeringId, input, actorId)` and `deleteSpecification(specId, offeringId, actorId)` both take the two ids as separate parameters, never bundled into the validated input. This unit's Server Actions mirror that shape exactly — `updateSpecificationAction(specId: string, offeringId: string, rawInput: unknown)`, `deleteSpecificationAction(specId: string, offeringId: string)` — and, following `update-offering.action.ts`'s own precedent (`offeringId: string` as a plain, unvalidated function parameter, not run through a schema), neither id is `.safeParse()`'d by this unit's actions. `pm14-spec` §3.2 is explicit that no delete schema exists in this phase ("`deleteSpecification`'s Server Action (pm21) will validate its id(s) directly") — read together with `update-offering.action.ts`'s shipped-precedent shape, "validate directly" means "typed as a plain string parameter, checked for existence by the service's own `OFFERING_NOT_FOUND`/`SPECIFICATION_NOT_FOUND` guards," not "run through a new bare-id Zod schema." This unit adds no new validation file for ids, on either the update or delete path.

### 2.2 The entry point — a sixth row action, "Specifications"

`pm18-spec`'s row-action matrix (§2.6, reused unmodified through pm19/pm20) renders exactly five actions across `DRAFT`/`ACTIVE`/`RETIRED`, and `prodmgmt-ui-context-phase2.md`'s icon/color table names exactly those five — Edit, Add price, Activate, Discard, Retire. None of them, and no other seam anywhere in pm18's spec, the mockup, or ui-context-phase2, is reserved for specification management, even though `pm99`'s own line for this unit says specs are "reached from the offering's detail/expansion surface." This is a genuine gap in the prior specs, not a hidden affordance to discover — resolved here, explicitly, the same way pm18 §2.2 resolved the equivalent gap for family grouping.

**Resolution:** add a sixth icon-only row-action button, **Specifications**, to the existing matrix, following its established visual and accessibility conventions exactly (28px square, `0.5px solid var(--border)`, quiet `--text-secondary` — never accent, never danger, since this action is neither this page's one reserved CTA nor a destructive transition):

| Status | New action | Icon (lucide-react) | Color role | `aria-label` |
|---|---|---|---|---|
| `DRAFT` | Specifications | `ListChecks` | `--text-secondary` | `"Manage specifications for ${row.name}"` |
| `ACTIVE` | Specifications | `ListChecks` | `--text-secondary` | `"Manage specifications for ${row.name}"` |
| `RETIRED` | *(none)* | — | — | Matches the existing "No actions — retired" treatment; this unit adds no exception to it. |

`ListChecks` is chosen because it is not already claimed by any of the five existing actions (`Pencil`, `CircleDollarSign`, `Check`, `Trash2`, `Archive`) and reads unambiguously as "a list of itemized things," distinct from `Pencil` (edit the offering's own fields) — a reviewer should not confuse "Edit" and "Specifications" by icon alone. This is this unit's own icon choice, not one `prodmgmt-ui-context-phase2.md` already made; `prodmgmt-ui-context-phase2.md`'s row-action table should be extended with this row in the same commit (Implementation §3.7), the same documentation-keeping discipline `pm19-spec` §2.5 applied to the guardrail test.

The button is placed after Retire/Discard (rightmost) in the action group, so the four "content" actions (Edit, Add price, Specifications treated as content-editing) and the one lifecycle-terminal action per status keep their existing relative grouping undisturbed — inserting a new button in the middle would silently reflow every existing `aria-label`/tab-order assertion pm18/pm19/pm20's own tests already lock in for the buttons after it. Concretely, the DRAFT order becomes Edit · Add price · Specifications · Activate · Discard; ACTIVE becomes Edit · Add price · Specifications · Retire.

### 2.3 The read-model gap this unit closes — specifications have to reach the client

**The blocker:** `ManageOfferingTable` receives `OfferingFamilyRow[]`, whose `primary`/`versions` entries are plain `OfferingListRow`s — `{ productOfferingId, name, lifecycleStatus, version, isSellable, lastModified, familyOfferingId, billingOnly }` (pm18/pm20's shape) — no specifications. Opening the Specifications dialog needs that offering's current specification list before it can render anything.

**Why not a new read Server Action:** `pm20-spec` §2.3 already rejected this exact move for its own smaller need (one boolean field), on the grounds that "this phase's whole action surface is deliberately enumerated as mutation-only" and a new read action isn't anticipated by any spec's action-file list or `prodmgmt-code-standards-phase2.md` §7's authoritative tree (which names exactly three action files for this unit, all mutations). That reasoning applies here with even more force — `pm99`'s own contract for this unit lists only the three mutation action files plus `specification-form.tsx`, nothing else.

**Why not extending `OfferingListRow`/`findList`'s `SELECT` the way pm18/pm20 did:** those two additions were each a single scalar column. Specifications are one-to-many per offering — forcing that shape into `findList`'s flat per-row `SELECT` would mean either a join that fans out `OfferingListRow` incorrectly (multiple rows per offering) or a second query per row bolted awkwardly onto a function every other page (View Product's `OfferingTable`, this page's own primary/version rows) already depends on returning a flat, offering-shaped row. Widening `OfferingListRow` itself — a type shared with View Product's read path — for a field only Manage Products' Specifications dialog needs would also make every other consumer of that type carry a field it never populates or uses.

**Resolution — reuse `getOfferingDetail` unmodified, called once per distinct offering id already being displayed, from `page.tsx`:** `services/product/get-offering-detail.ts` already exists, already returns `specifications: SpecificationCard[]` as part of its `OfferingDetail` shape, and is already used elsewhere in this module (View Product). `app/(app)/products/manage-products/page.tsx` (pm18's file, already looping `listOfferings` to build `fetchAllOfferingRows`) gains one more private, page-local helper:

```ts
async function fetchSpecificationsByOfferingId(
  rows: OfferingListRow[],
): Promise<Record<string, SpecificationCard[]>> {
  const entries = await Promise.all(
    rows.map(async (row) => {
      const detail = await getOfferingDetail(row.productOfferingId);
      return [row.productOfferingId, detail?.specifications ?? []] as const;
    }),
  );
  return Object.fromEntries(entries);
}
```

...called once, alongside `groupIntoFamilies(rows)`, and passed down to `ManageOfferingTable` as a new prop, `specificationsByOfferingId: Record<string, SpecificationCard[]>`. This is additive only: no new repository method, no new service export, no change to `getOfferingDetail`'s signature or behavior, no change to `OfferingListRow`/`OfferingFamilyRow`'s own type shape (unlike pm18/pm20's additions, this unit's read-model addition lives entirely in a new sibling map, not a widened row type) — and, structurally, no new mutation surface, which is the actual thing `prodmgmt-architecture-phase2.md` §2's "no new backend code" line for this folder is protecting (the same reading pm18 §2.2 point 1 already established).

**Disclosed cost, flagged rather than silently accepted:** `getOfferingDetail` also fetches and computes each offering's *prices* (with effectivity-status resolution), which this unit discards immediately. This doubles the module's per-row query cost on every Manage Products page load (once via `listOfferings`, once more via `getOfferingDetail` per row) beyond what pm18's own `fetchAllOfferingRows` already costs. This is accepted for the same reason pm18 §2.2 point 4 accepted its own page-looping approach: the catalog this module manages is an internal, ops-curated set with no documented scale target, and reusing an existing, already-tested export with zero new backend surface is worth more, at this phase, than the wasted `prices` computation. If the catalog's size later makes this a real concern, a narrower `getOfferingSpecifications(offeringId)` read service (or a return-shape split on `getOfferingDetail`) is the fix — flagged here so it is not lost, not this unit's problem to pre-solve.

### 2.4 One dialog, two views, plus a nested `AlertDialog` for delete — not three separate dialog files

Two established precedents pull in different directions:

- `pm19`'s `CreateOfferingDialog` and (per pm20 §2.1) the *absence* of a separate `edit-offering-dialog.tsx` both argue for keeping dialog surface area minimal — one component per row-action seam, not one per outcome.
- Specification management genuinely has two outcomes reachable from the same entry point — "see the list, and act on an item in it" — that `OfferingForm`'s single-shot create/edit modes don't need to reconcile, because Edit/Create offering are reached from two *different* buttons (the row's Edit action; the page's "New offering" CTA), never the same one.

**Resolution:** one new component, `SpecificationsDialog` (`components/products/manage/specifications-dialog.tsx`), opened by the sixth row action (§2.2). It renders exactly one Radix `Dialog`, and swaps its **content** between two internal views based on local state (`view: "list" | "form"`) rather than opening a second, stacked `Dialog` for the form — genuine Dialog-in-Dialog nesting has real, avoidable focus-trap/z-index complications that a same-dialog content swap sidesteps entirely, while still satisfying "specification add/edit happens in a modal dialog with `SpecificationForm` inside," which is what a click on "Add specification" or a row's Edit pencil, inside the list view, produces:

- **List view** (the default view on open): a compact table of the target offering's current specifications (`name`, `Mandatory`/`Default` yes/no chips, `defaultValue`, characteristic count — "3 characteristics"), each row with its own Edit (`Pencil`) button and, only when `offeringStatus === "DRAFT"` (§2.8), a Delete (`Trash2`, `--text-danger`) button. A header "Add specification" button (`Plus`, quiet) sits above the table. `DialogTitle` reads `"Specifications — ${offeringName}"`. Below the title, the same `--bg-warning`/`--text-warning` banner `pm20`'s Edit dialog already established renders **only** when `offeringStatus === "ACTIVE"`, reusing its exact copy pattern: *"`<Name>` is active. Adding or editing a specification here creates a new draft version instead."* (copy adapted from the offering-level original to name the actual mechanism this dialog triggers, not offering fields).
- **Form view**: `SpecificationForm` (§2.6), in `mode: "create"` (triggered by "Add specification") or `mode: "edit"` (triggered by a row's Edit button, `editingSpec` set to that row's `SpecificationCard`). `DialogTitle` switches to `"Add specification"` / `"Edit specification"`. A "Back" (ghost) button returns to the list view without submitting, discarding any in-progress edits — there is no unsaved-changes guard, matching every other form dialog in this module (`CreateOfferingDialog`, `EditOfferingForm`), none of which warn on discard.
- **Delete confirmation**: a nested `AlertDialog`, opened from a list-row's Delete button, layered on top of the still-open `Dialog` — this is the one place this unit does stack two Radix overlay primitives, and it is the supported, precedented combination (`AlertDialog` triggered from within an already-open surface), not the discouraged one (`Dialog`-in-`Dialog`). Built by reusing `components/roles/delete-role-dialog.tsx`'s exact shape — `AlertDialog`/`AlertDialogContent`/`AlertDialogHeader`/`AlertDialogTitle`/`AlertDialogDescription`/`AlertDialogFooter`/`AlertDialogCancel` plus a `destructive`-variant `Button` — inlined into `SpecificationsDialog` rather than factored into a fourth file, since (unlike `DeleteRoleDialog`, which is reused from two page contexts) this delete confirmation only ever has one caller.

No `SpecificationDialog` (singular) is ever a separate file, and no `AddSpecificationDialog`/`EditSpecificationDialog` naming is introduced — `SpecificationsDialog` (plural, one per offering, list-first) is this unit's one new binding component name; see §2.7 for where it gets formally added to the phase's naming registry.

### 2.5 Branch handling — mirrors pm20's `branched`-driven copy exactly, plus one new behavior pm20 didn't need

On a **direct** (`DRAFT`-target, `branched: false`) success — create, update, or delete alike — the dialog does **not** close. It stays on the list view (or returns to it, from the form view, after a create/update), shows a success toast (`"Specification added"` / `"Specification updated"` / `"Specification deleted"`), and calls `router.refresh()`. Because `specificationsByOfferingId` (§2.3) flows down from `page.tsx` as a prop, a `router.refresh()` while the dialog stays mounted re-runs the server fetch and hands the still-open `SpecificationsDialog` an updated `specifications` array on the next render — no separate client-side cache, no optimistic local list state to keep in sync by hand. This is a genuinely new micro-pattern relative to every prior unit in this build (pm19/pm20 always close their dialog before refreshing) — flagged explicitly because it's a deliberate fit to this dialog's own shape (a session where a user plausibly adds several specifications in a row to a fresh `DRAFT`, per `prodmgmt-project-overview-phase2.md`'s own Core User Flow step 5: "The user adds one or more specifications and at least one price to the `DRAFT`... these edits apply directly to it") rather than an arbitrary deviation.

On a **branch-producing** (`ACTIVE`-target, `branched: true`) success, this unit follows `pm20-spec` §2.9 to the letter instead: the dialog **closes** (`onOpenChange(false)`), a `"New draft version created"` toast fires, and the family this offering belongs to auto-expands via a `onBranch(familyId: string)` callback prop (parented by `ManageOfferingTable`'s own already-existing `expandedFamilies` state, exactly as `editingRow.familyId` drives it in pm20 §2.9), followed by `router.refresh()`. The dialog is **not** silently re-targeted at the new sibling draft's id to let the user keep adding specs in the same session — `prodmgmt-project-overview-phase2.md`'s Core User Flow step 9 describes the intended shape of this moment explicitly: "The user reviews the new draft, adjusts anything else needed (in place, since it's now a draft)" — i.e., the user returns to the table, sees the new `DRAFT` row (now visible because its family is expanded), and re-opens **that** row's own Specifications action to continue, which is then a direct (non-branching) path per §2.5's first paragraph. Re-targeting the same open dialog to a freshly-created id was considered and rejected: it would mean every subsequent Add/Edit click inside one continuous dialog session risks re-branching *again* if the developer got the re-targeting logic wrong, and it introduces a "this dialog's `offeringId` prop silently changed underneath the caller" behavior no other dialog in this codebase has. Closing and letting the user re-enter through the now-visible new row is simpler, and consistent with how every other branch-producing action in this build already surfaces its result.

### 2.6 The characteristics editor — a UI-only schema and translation layer, not `createSpecificationSchema` reused directly

`productSpecCharacteristics` is `z.record(z.string().min(1), z.string())` — a flat `Record<string, string>` with no fixed key set (`validation/product/product-spec-characteristics.schema.ts`, unchanged, reused as-is). No existing form in this codebase edits a `Record`-shaped field; every one (`RoleForm`, `UserForm`, `OfferingForm`) has a fixed set of named fields. `react-hook-form`'s `useFieldArray` needs an **array** to manage add/remove rows, not an object — so `SpecificationForm`'s internal form state represents characteristics as `characteristicsList: { key: string; value: string }[]`, translated to and from the wire `Record<string, string>` shape at the form's own boundary, never inside the Server Action or service (both of which continue to see/produce a plain `Record`, per pm14's schemas, completely unchanged by this unit).

This means `SpecificationForm` cannot validate directly against `createSpecificationSchema`/`updateSpecificationSchema` (pm14) — those schemas expect `productSpecCharacteristics` as a `Record`, and `useForm`'s `zodResolver` needs a schema matching whatever shape the form's own fields actually produce. So this unit defines one new, UI-only Zod schema, living in `specification-form.tsx` itself (not `validation/product/`, since it is never reused at the action boundary — the action still validates the translated `Record` against pm14's own schema, unchanged):

```ts
const specificationFormSchema = z.object({
  name: z.string().trim().min(1, "Specification name is required").max(200, "Specification name must be 200 characters or fewer"),
  isMandatory: z.boolean(),
  isDefault: z.boolean(),
  defaultValue: z.string().trim().max(500, "Default value must be 500 characters or fewer"),
  characteristicsList: z
    .array(
      z.object({
        key: z.string().trim().min(1, "Key is required"),
        value: z.string().trim().min(1, "Value is required"),
      }),
    )
    .refine(
      (list) => new Set(list.map((item) => item.key)).size === list.length,
      { message: "Characteristic keys must be unique" },
    ),
});
```

Three deliberate differences from pm14's wire schema, each necessary and each flagged: (1) `defaultValue` stays a plain (non-nullable) string in the form — an empty input, not `null`, is the "no default value" representation a text field can natively hold; translated to `null` only at submit time (§3.3's `toWireInput`). (2) each characteristic's `value` is `.min(1)` in the form even though the wire schema's `z.record(z.string().min(1), z.string())` allows an empty-string *value* (only the *key* has a `.min(1)`) — this unit chooses to reject empty-value characteristic rows at the UI layer as a usability guard against silently-blank rows, a stricter-than-the-wire-schema client-side rule, not a contradiction of it (the wire schema still accepts whatever this stricter form happens to produce). (3) the duplicate-key `.refine` exists **only** in the form schema — `Object.fromEntries` (the translation step, §3.3) would otherwise silently let a later duplicate key overwrite an earlier one with no warning, which the wire `Record` shape has no way to detect after the fact (by the time it's a `Record`, the duplicate is already gone). Catching it before translation is the only point in the pipeline where it's still visible.

This is a deliberately different kind of "UI-facing companion schema" than pm20's `editOfferingFieldsSchema` (a same-file `.omit()` of the wire schema, structurally identical minus one field) — here, the form's own shape is genuinely different (array vs. record) from the wire shape, so a hand-written parallel schema plus an explicit translation function is the correct tool, not a derived `.omit()`/`.extend()`. `recordToList`/`listToRecord` (a `.map`/`Object.fromEntries` pair, Implementation §3.3) are this translation layer's two halves — pure, private, exported from nowhere else, tested directly (§3.8).

### 2.7 One new binding component name — added to the phase's own naming registry in this commit

`SpecificationsDialog` does not appear in `prodmgmt-code-standards-phase2.md` §4's binding-name list or §7's file tree, which name only `SpecificationForm`/`specification-form.tsx` for this unit. Per the discipline `pm19-spec` §2.5 established for the guardrail array ("so CI never sits red between the unit that adds a file and the unit that's nominally responsible for [documenting it]"), this unit appends `SpecificationsDialog` (`specifications-dialog.tsx`) to both lists in the same commit, rather than leaving code-standards-phase2 silently out of date until some later cleanup unit notices. See Implementation §3.7.

### 2.8 Delete is UI-gated to `DRAFT` only — deliberately narrower than what the service allows

`pm14-spec`'s `deleteSpecification` service *does* support an `ACTIVE`-target call — it branches first, then deletes the cloned counterpart, exactly like `addSpecification`/`updateSpecification` — and its own guardrail 10 language is about the **repository** call being unreachable against an `ACTIVE` offering "by construction," not about the service being uncallable. `pm99`'s own line for this unit, though, states the *UI* contract narrowly and literally: **"delete is only ever offered on a `DRAFT`."** This unit follows that literally: `SpecificationsDialog`'s list view renders a Delete button on a specification row **only when** `offeringStatus === "DRAFT"` (§2.4) — never on `ACTIVE`, even though `deleteSpecificationAction`/`deleteSpecification` would technically handle an `ACTIVE` target correctly if called. This makes pm14's branch-first delete path dead code from this unit's own UI, permanently — flagged explicitly, the same way `pm20-spec` §2.8 flags its own unreachable-but-defensively-guarded `OFFERING_RETIRED` case, rather than treating an unreachable path as an oversight. The reasoning: unlike add/edit (where "this creates a new draft version, and here's what that means" is a legible, single-step warning, §2.4's banner), "deleting this spec from a live offering will silently produce a new draft that excludes it, without deleting anything visible right now" is a materially more confusing thing to explain in one banner, and the product spec's own success criteria treat "delete is DRAFT-only" as a hard UX rule, not just a backend guarantee to expose faithfully. Add and Edit remain available on `ACTIVE` (branch-first, per §2.4/§2.5) — only Delete is narrowed.

### 2.9 What this unit explicitly does NOT do

- No changes to the `Add price`/`Activate`/`Discard`/`Retire` seams, or to `OfferingForm`/`CreateOfferingDialog`'s own Edit/Create behavior — those stay exactly as pm18–pm20 left them.
- No no-op guard on the specification update path — this unit's UI simply calls `updateSpecificationAction` whenever the form is submitted; `pm14-spec` Design already establishes that `updateSpecification` always writes and always audits, even on identical resubmitted values, and this unit does not add a client-side "did anything actually change" check on top of that.
- No price fields, no offering-level fields on this dialog — unchanged scope from every sibling unit; `SpecificationsDialog` only ever touches one offering's specifications.
- No new audit event type — `PRODUCT_SPECIFICATION_CREATED`/`_UPDATED`/`_DELETED` already exist (pm14); this unit's actions only call the existing services.
- No change to `app/(app)/products/manage-products/page.tsx`'s existing `fetchAllOfferingRows`/`groupIntoFamilies` logic beyond the one additive helper and prop described in §2.3 — the page's guard, its two existing fetches, and its family-grouping logic are otherwise untouched.
- No attempt to let a user reorder specifications, bulk-edit several at once, or edit `isBundle`/other offering-level flags from within this dialog.

## 3. Implementation

### 3.1 Read model — `app/(app)/products/manage-products/page.tsx` (edit — one helper, one fetch, one new prop)

```ts
import { getOfferingDetail } from "@/services/product/get-offering-detail";
import type { SpecificationCard } from "@/types/product";

// pm21-spec §2.3. Reuses the existing, unmodified getOfferingDetail export —
// no new repository method, no new service, no widened OfferingListRow.
// Discards `prices`/other detail fields; only `specifications` is kept.
async function fetchSpecificationsByOfferingId(
  rows: OfferingListRow[],
): Promise<Record<string, SpecificationCard[]>> {
  const entries = await Promise.all(
    rows.map(async (row) => {
      const detail = await getOfferingDetail(row.productOfferingId);
      return [row.productOfferingId, detail?.specifications ?? []] as const;
    }),
  );
  return Object.fromEntries(entries);
}
```

In `ManageProductsPage`, alongside the existing `fetchAllOfferingRows()`/`groupIntoFamilies(rows)` calls:

```ts
const rows = await fetchAllOfferingRows();
const families = groupIntoFamilies(rows);
const specificationsByOfferingId = await fetchSpecificationsByOfferingId(rows);
// ...
<ManageOfferingTable
  families={families}
  locale={locale}
  timezone={timezone}
  specificationsByOfferingId={specificationsByOfferingId}
/>
```

No other line in `page.tsx` changes — `resolveFamilyId`/`selectPrimary`/`groupIntoFamilies`/the page's guard are untouched.

### 3.2 Validation — no new files (see Design §2.1/§2.6)

`create-specification.schema.ts`/`update-specification.schema.ts` (pm14) are imported and used unchanged by the two mutation actions below. `specificationFormSchema` (Design §2.6) lives inside `specification-form.tsx`, not `validation/product/` — it is a UI-only shape, never used at an action boundary.

### 3.3 Form — `components/products/manage/specification-form.tsx` (new)

```tsx
"use client";

import { Controller, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, X } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CreateSpecificationInput } from "@/validation/product/create-specification.schema";
import type { ProductSpecCharacteristics } from "@/validation/product/product-spec-characteristics.schema";

// pm21-spec §2.6. UI-only — never imported by an action or service. Shape
// differs deliberately from createSpecificationSchema/updateSpecificationSchema
// (array of key/value pairs vs. a Record), because useFieldArray needs an
// array to manage add/remove rows.
const specificationFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Specification name is required")
    .max(200, "Specification name must be 200 characters or fewer"),
  isMandatory: z.boolean(),
  isDefault: z.boolean(),
  defaultValue: z
    .string()
    .trim()
    .max(500, "Default value must be 500 characters or fewer"),
  characteristicsList: z
    .array(
      z.object({
        key: z.string().trim().min(1, "Key is required"),
        value: z.string().trim().min(1, "Value is required"),
      }),
    )
    .refine(
      (list) => new Set(list.map((item) => item.key)).size === list.length,
      { message: "Characteristic keys must be unique" },
    ),
});
type SpecificationFormValues = z.infer<typeof specificationFormSchema>;

function recordToList(
  record: ProductSpecCharacteristics,
): { key: string; value: string }[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function listToRecord(
  list: { key: string; value: string }[],
): ProductSpecCharacteristics {
  return Object.fromEntries(list.map(({ key, value }) => [key, value]));
}

// pm21-spec §3.3. Translates the form's own shape to the wire shape
// (CreateSpecificationInput === UpdateSpecificationInput, field-identical
// per pm14-spec §3.1/§3.2) at the one boundary where the two diverge.
function toWireInput(values: SpecificationFormValues): CreateSpecificationInput {
  return {
    name: values.name,
    isMandatory: values.isMandatory,
    isDefault: values.isDefault,
    defaultValue: values.defaultValue.trim() === "" ? null : values.defaultValue.trim(),
    productSpecCharacteristics: listToRecord(values.characteristicsList),
  };
}

export interface SpecificationFormDefaultValues {
  name: string;
  isMandatory: boolean;
  isDefault: boolean;
  defaultValue: string | null;
  characteristics: ProductSpecCharacteristics;
}

export interface SpecificationFormProps {
  mode: "create" | "edit";
  defaultValues?: SpecificationFormDefaultValues;
  onSubmit: (values: CreateSpecificationInput) => Promise<void>;
  isSubmitting: boolean;
  formId: string;
}

export function SpecificationForm({
  mode,
  defaultValues,
  onSubmit,
  isSubmitting,
  formId,
}: SpecificationFormProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<SpecificationFormValues>({
    resolver: zodResolver(specificationFormSchema),
    defaultValues: {
      name: defaultValues?.name ?? "",
      isMandatory: defaultValues?.isMandatory ?? false,
      isDefault: defaultValues?.isDefault ?? false,
      defaultValue: defaultValues?.defaultValue ?? "",
      characteristicsList: defaultValues
        ? recordToList(defaultValues.characteristics)
        : [],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "characteristicsList",
  });

  return (
    <form
      id={formId}
      noValidate
      onSubmit={(e) => void handleSubmit((values) => onSubmit(toWireInput(values)))(e)}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="spec-name">Name</FieldLabel>
          <Input
            id="spec-name"
            type="text"
            autoComplete="off"
            autoFocus
            aria-invalid={!!errors.name}
            disabled={isSubmitting}
            {...register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="spec-default-value">Default value</FieldLabel>
          <Input
            id="spec-default-value"
            type="text"
            autoComplete="off"
            aria-invalid={!!errors.defaultValue}
            disabled={isSubmitting}
            {...register("defaultValue")}
          />
          <FieldError errors={[errors.defaultValue]} />
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-body-sm font-medium text-foreground">
            Options
          </legend>

          <Controller
            control={control}
            name="isMandatory"
            render={({ field }) => (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={field.value}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                />
                Mandatory
              </label>
            )}
          />

          <Controller
            control={control}
            name="isDefault"
            render={({ field }) => (
              <label className="flex items-center gap-2 text-body-sm">
                <Checkbox
                  checked={field.value}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                />
                Default
              </label>
            )}
          />
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-body-sm font-medium text-foreground">
            Characteristics
          </legend>

          {fields.map((field, index) => (
            <div key={field.id} className="flex items-start gap-2">
              <Field className="flex-1">
                <Input
                  aria-label={`Characteristic ${index + 1} key`}
                  placeholder="Key"
                  disabled={isSubmitting}
                  {...register(`characteristicsList.${index}.key` as const)}
                />
                <FieldError errors={[errors.characteristicsList?.[index]?.key]} />
              </Field>
              <Field className="flex-1">
                <Input
                  aria-label={`Characteristic ${index + 1} value`}
                  placeholder="Value"
                  disabled={isSubmitting}
                  {...register(`characteristicsList.${index}.value` as const)}
                />
                <FieldError errors={[errors.characteristicsList?.[index]?.value]} />
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove characteristic ${index + 1}`}
                disabled={isSubmitting}
                onClick={() => remove(index)}
              >
                <X size={16} aria-hidden />
              </Button>
            </div>
          ))}

          {errors.characteristicsList?.root && (
            <p className="text-body-sm text-[color:var(--text-danger)]">
              {errors.characteristicsList.root.message}
            </p>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSubmitting}
            onClick={() => append({ key: "", value: "" })}
          >
            <Plus size={14} aria-hidden />
            Add characteristic
          </Button>
        </fieldset>
      </FieldGroup>
    </form>
  );
}
```

Notes: `formId` is a required prop (not hardcoded, unlike `CreateOfferingForm`'s literal `"offering-form-create"`) because `SpecificationsDialog` needs two logically distinct form instances over its lifetime — create and edit — and passes a stable id (`"specification-form"`) either way; it is a prop rather than a hardcoded string purely so a future caller isn't forced to reuse the exact same DOM id if this component is ever mounted twice on one page (not currently the case, but costs nothing to allow). `mode` is accepted but not branched on inside this component — every difference between create and edit is entirely captured by `defaultValues` being present or absent; `SpecificationsDialog` (§3.4) is what decides which action to call, and what `DialogTitle`/submit-button copy to show, based on `mode`.

### 3.4 Dialog — `components/products/manage/specifications-dialog.tsx` (new)

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { createSpecificationAction } from "@/actions/product/create-specification.action";
import { deleteSpecificationAction } from "@/actions/product/delete-specification.action";
import { updateSpecificationAction } from "@/actions/product/update-specification.action";
import {
  SpecificationForm,
  type SpecificationFormDefaultValues,
} from "@/components/products/manage/specification-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CreateSpecificationInput } from "@/validation/product/create-specification.schema";
import type { SpecificationCard } from "@/types/product";

export interface SpecificationsDialogProps {
  offeringId: string;
  offeringName: string;
  offeringStatus: "DRAFT" | "ACTIVE";
  familyId: string;
  specifications: SpecificationCard[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onBranch: (familyId: string) => void;
}

type View = { name: "list" } | { name: "form"; editingSpec: SpecificationCard | null };

export function SpecificationsDialog({
  offeringId,
  offeringName,
  offeringStatus,
  familyId,
  specifications,
  isOpen,
  onOpenChange,
  onBranch,
}: SpecificationsDialogProps): React.JSX.Element {
  const router = useRouter();
  const [view, setView] = useState<View>({ name: "list" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingSpec, setDeletingSpec] = useState<SpecificationCard | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // pm21-spec §2.5. `open` transitions reset to the list view so a
  // re-opened dialog never resumes mid-edit against stale defaultValues.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setView({ name: "list" });
  }

  function handleDialogOpenChange(open: boolean): void {
    if (isSubmitting) return;
    onOpenChange(open);
  }

  async function handleFormSubmit(values: CreateSpecificationInput): Promise<void> {
    const editingSpec = view.name === "form" ? view.editingSpec : null;
    setIsSubmitting(true);
    try {
      const result = editingSpec
        ? await updateSpecificationAction(editingSpec.productSpecId, offeringId, values)
        : await createSpecificationAction(offeringId, values);

      if (result.ok) {
        if (result.branched) {
          onOpenChange(false);
          toast.success("New draft version created");
          onBranch(familyId);
          router.refresh();
        } else {
          toast.success(editingSpec ? "Specification updated" : "Specification added");
          setView({ name: "list" });
          router.refresh();
        }
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_RETIRED") {
        toast.error("This offering has been retired and can no longer be edited.");
      } else if (
        result.code === "OFFERING_NOT_FOUND" ||
        result.code === "SPECIFICATION_NOT_FOUND"
      ) {
        toast.error("This item no longer exists. Refreshing...");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteConfirm(): Promise<void> {
    if (!deletingSpec) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      // Delete is only ever offered on a DRAFT row (Design §2.8), so
      // result.branched is always false on any reachable call here — the
      // check below is still handled, not assumed, matching pm14's own
      // "guard it anyway" defensive stance for unreachable-by-construction
      // cases.
      const result = await deleteSpecificationAction(deletingSpec.productSpecId, offeringId);
      if (result.ok) {
        setDeletingSpec(null);
        if (result.branched) {
          onOpenChange(false);
          toast.success("New draft version created");
          onBranch(familyId);
        } else {
          toast.success("Specification deleted");
        }
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        setDeleteError("You don't have permission to do that.");
      } else if (result.code === "OFFERING_RETIRED") {
        setDeleteError("This offering has been retired and can no longer be edited.");
      } else if (
        result.code === "OFFERING_NOT_FOUND" ||
        result.code === "SPECIFICATION_NOT_FOUND"
      ) {
        setDeletingSpec(null);
        onOpenChange(false);
        toast.error("This item no longer exists. Refreshing...");
        router.refresh();
      } else {
        setDeleteError("Something went wrong. Please try again.");
      }
    } catch {
      setDeleteError("Something went wrong. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent>
          {view.name === "list" ? (
            <>
              <DialogHeader>
                <DialogTitle>Specifications — {offeringName}</DialogTitle>
              </DialogHeader>

              {offeringStatus === "ACTIVE" && (
                <div className="mb-3 rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
                  {offeringName} is active. Adding or editing a specification here
                  creates a new draft version instead.
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setView({ name: "form", editingSpec: null })}
                >
                  <Plus size={14} aria-hidden />
                  Add specification
                </Button>
              </div>

              {specifications.length === 0 ? (
                <p className="py-4 text-center text-body-sm text-muted-foreground">
                  No specifications yet.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {specifications.map((spec) => (
                    <li
                      key={spec.productSpecId}
                      className="flex items-center justify-between gap-2 py-2"
                    >
                      <div>
                        <p className="text-body-sm font-medium text-foreground">
                          {spec.name}
                        </p>
                        <p className="text-body-sm text-muted-foreground">
                          {spec.isMandatory ? "Mandatory" : "Optional"} ·{" "}
                          {spec.isDefault ? "Default" : "Not default"} ·{" "}
                          {Object.keys(spec.characteristics).length} characteristic
                          {Object.keys(spec.characteristics).length === 1 ? "" : "s"}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${spec.name}`}
                          onClick={() => setView({ name: "form", editingSpec: spec })}
                        >
                          <Pencil size={16} aria-hidden />
                        </Button>
                        {offeringStatus === "DRAFT" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete ${spec.name}`}
                            onClick={() => {
                              setDeleteError(null);
                              setDeletingSpec(spec);
                            }}
                          >
                            <Trash2 size={16} className="text-[color:var(--text-danger)]" aria-hidden />
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {view.editingSpec ? "Edit specification" : "Add specification"}
                </DialogTitle>
              </DialogHeader>

              <SpecificationForm
                mode={view.editingSpec ? "edit" : "create"}
                formId="specification-form"
                defaultValues={
                  view.editingSpec
                    ? {
                        name: view.editingSpec.name,
                        isMandatory: view.editingSpec.isMandatory,
                        isDefault: view.editingSpec.isDefault,
                        defaultValue: view.editingSpec.defaultValue,
                        characteristics: view.editingSpec.characteristics,
                      }
                    : undefined
                }
                onSubmit={handleFormSubmit}
                isSubmitting={isSubmitting}
              />

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={isSubmitting}
                  onClick={() => setView({ name: "list" })}
                >
                  Back
                </Button>
                <Button type="submit" form="specification-form" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="animate-spin" />}
                  {view.editingSpec ? "Save changes" : "Add specification"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* pm21-spec §2.4. Nested AlertDialog, layered on top of the open
          Dialog above — reuses components/roles/delete-role-dialog.tsx's
          exact shape, the one real shipped hard-delete precedent in this
          codebase. Only ever rendered while offeringStatus === "DRAFT"
          (Design §2.8), since that's the only state deletingSpec can be set
          from. */}
      <AlertDialog
        open={!!deletingSpec}
        onOpenChange={isDeleting ? () => {} : (open) => !open && setDeletingSpec(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete specification</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the specification{" "}
              <strong>{deletingSpec?.name}</strong>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteError && (
            <Alert variant="destructive">
              <AlertDescription>{deleteError}</AlertDescription>
            </Alert>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDeleteConfirm()}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 size={14} className="mr-1 animate-spin" />}
              Delete specification
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
```

Imports `ListChecks` even though it's unused directly in this file's own JSX (it's re-exported implicitly via the row-action button in `manage-offering-table.tsx`, §3.5) — remove it from this file's import list if lint flags it unused; it is listed here only to keep this file's own icon set legible at a glance. (Flagged as a minor authoring note, not a real requirement — the actual icon import belongs in `manage-offering-table.tsx`.)

### 3.5 Server Action — `actions/product/create-specification.action.ts` (new)

```ts
"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { addSpecification } from "@/services/product/add-specification";
import { createSpecificationSchema } from "@/validation/product/create-specification.schema";

export type CreateSpecificationActionResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "VALIDATION_ERROR"; fieldErrors: Record<string, string[]> }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm21-spec §3.5. Mirrors create-offering.action.ts's guard → safeParse →
// delegate → revalidatePath shape (architecture-phase2 §1). offeringId is a
// plain function parameter, never a schema field (Design §2.1).
export async function createSpecificationAction(
  offeringId: string,
  rawInput: unknown,
): Promise<CreateSpecificationActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(PERMISSIONS.PRODUCTS, LEVELS.EDIT));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = createSpecificationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await addSpecification(offeringId, parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return {
    ok: true,
    offeringId: result.offeringId,
    productSpecId: result.productSpecId,
    branched: result.branched,
  };
}
```

### 3.6 Server Action — `actions/product/update-specification.action.ts` (new)

```ts
"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { updateSpecification } from "@/services/product/update-specification";
import { updateSpecificationSchema } from "@/validation/product/update-specification.schema";

export type UpdateSpecificationActionResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "VALIDATION_ERROR"; fieldErrors: Record<string, string[]> }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "SPECIFICATION_NOT_FOUND" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm21-spec §3.6. Both specId and offeringId travel as separate function
// parameters (Design §2.1) — updateSpecification(specId, offeringId, input, actorId).
export async function updateSpecificationAction(
  specId: string,
  offeringId: string,
  rawInput: unknown,
): Promise<UpdateSpecificationActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(PERMISSIONS.PRODUCTS, LEVELS.EDIT));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = updateSpecificationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await updateSpecification(specId, offeringId, parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return {
    ok: true,
    offeringId: result.offeringId,
    productSpecId: result.productSpecId,
    branched: result.branched,
  };
}
```

### 3.7 Server Action — `actions/product/delete-specification.action.ts` (new)

```ts
"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { deleteSpecification } from "@/services/product/delete-specification";

export type DeleteSpecificationActionResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "SPECIFICATION_NOT_FOUND" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm21-spec §3.7. No Zod schema — no delete schema exists in this phase
// (pm14-spec §3.2), and specId/offeringId are plain, unvalidated function
// parameters, mirroring update-offering.action.ts's own offeringId
// parameter precedent (Design §2.1). This unit's UI only ever calls this
// action against a DRAFT-status offering (Design §2.8) — the RETIRED/
// ACTIVE guards below are handled defensively anyway, matching pm14's own
// "guard it even though the shipped UI can't reach it" stance.
export async function deleteSpecificationAction(
  specId: string,
  offeringId: string,
): Promise<DeleteSpecificationActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(PERMISSIONS.PRODUCTS, LEVELS.EDIT));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  let result;
  try {
    result = await deleteSpecification(specId, offeringId, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return {
    ok: true,
    offeringId: result.offeringId,
    productSpecId: result.productSpecId,
    branched: result.branched,
  };
}
```

### 3.8 Filling the pm18 seam — `components/products/manage/manage-offering-table.tsx` (edit)

Add local state, alongside pm20's already-existing `editingRow`/`expandedFamilies`:

```ts
const [specsRow, setSpecsRow] = useState<{
  row: OfferingListRow;
  familyId: string;
} | null>(null);
```

Add the sixth row-action button (Design §2.2) to both the primary-row and expanded-sub-row rendering, immediately after "Add price," for every `DRAFT`/`ACTIVE` row (never `RETIRED`):

```tsx
{row.lifecycleStatus !== "RETIRED" && (
  <button
    type="button"
    aria-label={`Manage specifications for ${row.name}`}
    className="..." // same 28px/border treatment as every other row-action button
    onClick={() => setSpecsRow({ row, familyId: family.familyId })}
  >
    <ListChecks size={16} aria-hidden />
  </button>
)}
```

Render the dialog once, near the end of the component's JSX (a sibling of the existing edit dialog block):

```tsx
{specsRow && (
  <SpecificationsDialog
    offeringId={specsRow.row.productOfferingId}
    offeringName={specsRow.row.name}
    offeringStatus={specsRow.row.lifecycleStatus as "DRAFT" | "ACTIVE"}
    familyId={specsRow.familyId}
    specifications={specificationsByOfferingId[specsRow.row.productOfferingId] ?? []}
    isOpen
    onOpenChange={(open) => {
      if (!open) setSpecsRow(null);
    }}
    onBranch={(familyId) =>
      setExpandedFamilies((prev) => new Set(prev).add(familyId))
    }
  />
)}
```

`ManageOfferingTableProps` gains one field: `specificationsByOfferingId: Record<string, SpecificationCard[]>` (populated by `page.tsx`, §3.1). New imports: `ListChecks` (`lucide-react`), `SpecificationsDialog`. No other line in this file changes — the `Add price`/`Activate`/`Discard`/`Retire` seams and the already-wired Edit/"New offering" behavior stay byte-unchanged.

### 3.9 Documentation kept in sync — `prodmgmt-code-standards-phase2.md` and `prodmgmt-ui-context-phase2.md` (edit, same commit)

Per Design §2.7, append to §4's binding-name list: `SpecificationsDialog`. Append to §7's file tree, under `components/products/manage/`: `specifications-dialog.tsx  # SpecificationsDialog`.

Per Design §2.2, append one row to `prodmgmt-ui-context-phase2.md`'s row-action table:

```
| Specifications | `list-checks` | `--text-secondary` (quiet) | `DRAFT`, `ACTIVE` |
```

### 3.10 Guardrail test — `tests/guardrails/product-module-boundaries.test.ts` (edit — one array extended)

```ts
const EXPECTED_PRODUCT_ACTION_FILES = [
  "create-offering.action.ts",
  "update-offering.action.ts",
  "create-specification.action.ts",
  "update-specification.action.ts",
  "delete-specification.action.ts",
];
```

Per pm19-spec §2.5's own instruction, this unit appends its own three filenames in this same commit rather than deferring to pm24. No other assertion in this file changes.

### 3.11 Tests

- `tests/actions/create-specification.action.test.ts`, `update-specification.action.test.ts`, `delete-specification.action.test.ts` (new) — each mirrors `update-offering.action.test.ts`'s structure: mocks `requirePermission`, the corresponding service, and `next/cache`'s `revalidatePath`; asserts a successful call invokes the service with the exact parameters (`offeringId`/`specId` positioned correctly, per §2.1) and returns the service's result verbatim plus both `revalidatePath` calls; asserts an empty `name` (create/update only) returns `VALIDATION_ERROR` with `fieldErrors.name` populated; asserts a redirect from `requirePermission` returns `FORBIDDEN`; asserts the service's `OFFERING_NOT_FOUND`/`OFFERING_RETIRED`/`SPECIFICATION_NOT_FOUND` codes all pass through unchanged; asserts a thrown error returns `SERVER_ERROR`.
- `tests/components/specification-form.test.tsx` (new) — renders in create mode with no `defaultValues`; asserts the characteristics list starts empty and "Add characteristic" appends one blank key/value row; asserts submitting with a blank required field shows `FieldError`; asserts submitting two characteristic rows with the same key shows the duplicate-key error and does not call `onSubmit`; asserts a successful submit calls `onSubmit` with `productSpecCharacteristics` as a plain `Record<string, string>` (not an array) matching the entered rows, and `defaultValue: null` when the field was left blank; renders in edit mode with `defaultValues.characteristics = { SST_ID: "01", SD_ID: "02" }` and asserts the form prefills exactly two characteristic rows with those key/value pairs.
- `tests/components/specifications-dialog.test.tsx` (new) — mocks all three specification actions and `next/navigation`'s `useRouter`; renders with a two-item `specifications` fixture, one `DRAFT`-target and one `ACTIVE`-target case; asserts a `DRAFT`-target row shows both Edit and Delete buttons, an `ACTIVE`-target row shows Edit only (Design §2.8) and shows the `--bg-warning` banner (a `DRAFT`-target render shows no banner); asserts clicking "Add specification" switches to the form view with `mode="create"`; asserts a successful direct (`branched: false`) create/update/delete stays on the dialog (`isOpen` unchanged, verified via the mocked `onOpenChange` never being called with `false`), fires the matching success toast, and calls `router.refresh()`; asserts a successful branch-producing (`branched: true`) create/update/delete calls `onOpenChange(false)`, calls `onBranch(familyId)` with the fixture's `familyId`, fires the `"New draft version created"` toast, and calls `router.refresh()`; asserts clicking Delete opens the nested `AlertDialog` with the target spec's name, and confirming calls `deleteSpecificationAction` with the correct `(productSpecId, offeringId)` pair.
- `tests/components/manage-offering-table.test.tsx` (**edit**, pm18/pm19/pm20-owned file) — this file's existing "Specifications" placeholder assertion (there wasn't one before this unit — the sixth button didn't exist) is added fresh: clicking the new "Specifications" button on a `DRAFT` or `ACTIVE` row (primary or expanded sibling) opens `SpecificationsDialog` titled `"Specifications — ${row.name}"`; no "Specifications" button renders on a `RETIRED` row. Every other seam's own existing assertions (`Add price`/`Activate`/`Discard`/`Retire` "no attached behavior") remain untouched — those still belong to pm22/pm23.
- `tests/guardrails/product-module-boundaries.test.ts` — run the full suite; confirm the extended array (§3.10) passes and no other assertion regresses.

### 3.12 Commit

One commit. Contents: `app/(app)/products/manage-products/page.tsx` (edit — one helper, one fetch, one new prop threaded to `ManageOfferingTable`), `actions/product/create-specification.action.ts` (new), `actions/product/update-specification.action.ts` (new), `actions/product/delete-specification.action.ts` (new), `components/products/manage/specification-form.tsx` (new), `components/products/manage/specifications-dialog.tsx` (new), `components/products/manage/manage-offering-table.tsx` (edit — sixth row action added, dialog wired, one new prop), `prodmgmt-code-standards-phase2.md` (edit — `SpecificationsDialog` appended to §4/§7), `prodmgmt-ui-context-phase2.md` (edit — one row appended to the row-action table), `tests/guardrails/product-module-boundaries.test.ts` (edit — three filenames appended), five new/edited test files (§3.11). Explicitly **not** in this commit: any change to `services/product/add-specification.ts`/`update-specification.ts`/`delete-specification.ts` or `db/repositories/product-specification.ts` (pm14's own code, consumed here unmodified), any `db/migrations/` file, any change to `create-offering.action.ts`/`update-offering.action.ts`/`offering-form.tsx` (pm19/pm20's own files), any change to `app/(app)/products/product-offering/**`.

## 4. Dependencies

**No new npm packages.** Everything this unit needs is already installed and already used elsewhere in this codebase: `react-hook-form` + `@hookform/resolvers/zod` (`role-form.tsx`, `user-form.tsx`, `offering-form.tsx`) — including `useFieldArray`, which ships as part of the already-installed `react-hook-form` package and needs no separate dependency; `lucide-react`'s `ListChecks` (new icon for this unit, from the already-installed icon set — no version bump), `Pencil`/`Trash2`/`Plus`/`X`/`Loader2` (all already imported elsewhere in this module); `sonner`'s `toast`; `components/ui/dialog.tsx`, `components/ui/alert-dialog.tsx`, `components/ui/alert.tsx`, `components/ui/checkbox.tsx`, `components/ui/input.tsx`, `components/ui/field.tsx`, `components/ui/button.tsx` — all existing primitives, no new one added; `next/navigation`'s `useRouter`. No Zod, Drizzle, or Postgres-driver change — this unit adds one UI-only Zod schema (`specificationFormSchema`, never touching the DB) and reuses `getOfferingDetail`, an already-shipped, already-exported service, unmodified.

## 5. Verification checklist

**Diff hygiene**
- [ ] `git status` shows only the files listed in §3.12 — nothing under `services/product/*-specification.ts`, `db/repositories/product-specification.ts`, `db/migrations/`, `db/schema/`, `actions/product/create-offering.action.ts` or `update-offering.action.ts`, or `components/products/manage/offering-form.tsx`.
- [ ] `app/(app)/products/manage-products/page.tsx`'s diff is exactly the one new helper, one new `await`, and one new prop passed to `ManageOfferingTable` — `resolveFamilyId`/`selectPrimary`/`groupIntoFamilies`/the page's guard are byte-identical to before this unit.
- [ ] `services/product/get-offering-detail.ts` is untouched — this unit only calls it, never modifies its signature or behavior.
- [ ] No `SpecificationDialog`, `AddSpecificationDialog`, or `EditSpecificationDialog` file exists anywhere in `components/products/manage/` — confirms Design §2.4's single-dialog-two-views resolution was actually followed.
- [ ] `create-specification.schema.ts`/`update-specification.schema.ts` (pm14) are byte-identical to before this unit — this unit imports them, never edits them.

**Backend/Action correctness**
- [ ] An unpermitted caller invoking any of the three actions gets `{ ok: false, code: "FORBIDDEN" }`, and the corresponding service is never called.
- [ ] A `products:EDIT` caller submitting a valid create against a `DRAFT` offering gets `{ ok: true, offeringId: <same id>, productSpecId, branched: false }`; against an `ACTIVE` offering gets `branched: true` and a different `offeringId` than the one passed in.
- [ ] `updateSpecificationAction`/`deleteSpecificationAction` each pass `specId`/`offeringId` to their service in the correct parameter order — confirmed by a mocked-call assertion, not just a passing return value.
- [ ] An empty `name` on create/update returns `VALIDATION_ERROR` with `fieldErrors.name` populated, and the service is never called.
- [ ] `OFFERING_NOT_FOUND`/`OFFERING_RETIRED`/`SPECIFICATION_NOT_FOUND` from each service pass through their action unchanged.
- [ ] A thrown error from any service returns `SERVER_ERROR`, not an unhandled exception.

**UI behavior — the point of the unit**
- [ ] A "Specifications" action button renders on every `DRAFT` and `ACTIVE` row (family primary and expanded siblings alike), and on none of the five other pre-existing action buttons' positions — no `RETIRED` row shows it.
- [ ] Clicking "Specifications" on a `DRAFT` row opens `SpecificationsDialog` on its list view, titled `"Specifications — <name>"`, no warning banner, every existing specification row showing both Edit and Delete buttons.
- [ ] Clicking "Specifications" on an `ACTIVE` row opens the same dialog with the `--bg-warning` banner visible and every row showing Edit only — no Delete button anywhere in this dialog's DOM while it's open against an `ACTIVE` offering.
- [ ] "Add specification" on a `DRAFT` target: submitting a valid form (including at least one characteristic key/value pair) closes the form view, returns to the list view showing the new row, fires an "Specification added" toast, and the dialog stays open (no `onOpenChange(false)` call).
- [ ] "Add specification" on an `ACTIVE` target: submitting closes the whole dialog, fires "New draft version created," and the target's family auto-expands in the underlying table without a further click — confirmed the newly created sibling `DRAFT` row is visible with the added specification when re-opened.
- [ ] Editing an existing specification on a `DRAFT` target updates that same row in place (visible immediately in the still-open dialog's list) with an "Specification updated" toast; on an `ACTIVE` target it produces a branched sibling exactly as create does, and the source `ACTIVE` offering's own specifications are unchanged afterward (re-fetch and compare).
- [ ] Deleting a specification (only reachable on a `DRAFT` target) opens the nested `AlertDialog` naming that spec; confirming removes it from the list (dialog stays open, "Specification deleted" toast fires); Cancel closes only the `AlertDialog`, leaving the underlying `SpecificationsDialog` open and the specification list unchanged.
- [ ] The characteristics editor: "Add characteristic" appends a blank key/value row; removing a row via its own `X` button removes exactly that row; submitting with a duplicate key across two rows shows the duplicate-key error and does not submit; submitting with an empty key or empty value on any row shows that field's own error and does not submit; a successful submit's resulting specification's `characteristics` (fetched from the DB afterward) is a flat object exactly matching the entered key/value pairs, with no `characteristicsList`/array artifact anywhere.
- [ ] Editing an existing specification whose `characteristics` has two or more entries prefills the form with exactly that many key/value rows, each showing the correct existing key and value.
- [ ] The dialog cannot be dismissed (Close, overlay click, Escape) while a create/update/delete submission is in flight.
- [ ] A real `PRODUCT_SPECIFICATION_CREATED`/`_UPDATED`/`_DELETED` audit row is written for each action end-to-end (not just asserted at the type level) — confirms pm14's services are genuinely invoked, not just their signatures matched.

**Guardrail suite**
- [ ] `tests/guardrails/product-module-boundaries.test.ts`'s extended `EXPECTED_PRODUCT_ACTION_FILES` assertion (§3.10) passes: `actions/product/` contains exactly the five files listed there (two from pm19/pm20, three from this unit).
- [ ] Every other guardrail assertion in that file still passes unmodified, in particular guardrail 10 ("Spec-delete unreachable on `ACTIVE`") — confirmed both by pm14's own construction and, now, by this unit's own UI never rendering a Delete affordance on an `ACTIVE`-target dialog (§2.8).
- [ ] `tests/components/manage-offering-table.test.tsx`'s new "Specifications" assertions (§3.11) pass; its other five seams' assertions remain unmodified.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm run test` green — full suite, including every new/edited test file above.
- [ ] `npm run build` passes.

**Docs in sync**
- [ ] `prodmgmt-code-standards-phase2.md` §4/§7 and `prodmgmt-ui-context-phase2.md`'s row-action table both show `SpecificationsDialog`/the new "Specifications" row, added in this unit's own commit (§3.9), not deferred.
- [ ] `prodmgmt-progress-tracker.md` (real repo copy) gets a pm21 entry with the commit reference, and explicitly records the two design calls a future unit (pm22/pm23) might otherwise re-litigate: the "stay open + `router.refresh()`" pattern for direct (non-branching) success (Design §2.5) as a deliberate departure from pm19/pm20's own "always close" convention, and the read-model resolution (Design §2.3, reusing `getOfferingDetail` per-row rather than widening `OfferingListRow`) — so a later unit doesn't independently re-derive either decision under a different shape.

**Pipeline**
- [ ] CI green end-to-end. This unit adds three action files to an already-established mutation surface and one new dialog; the SAST/DAST baseline should show no new finding beyond what's already expected for a standard Server-Action-backed CRUD-over-a-list dialog.

Any failing item means the unit is not done. Units pm22 (Price) and pm23 (Lifecycle) each follow the same action/guardrail-increment shape this unit and pm19/pm20 established — do not start either assuming a different pattern, and in particular do not reflexively copy this unit's "stay open, `router.refresh()`" success-handling shape onto a seam that doesn't share its "one entry point, multiple sequential actions in one sitting" reasoning (Add price and the lifecycle actions each have exactly one outcome per pm99's own contract, closer to pm19/pm20's own "always close" shape than to this unit's).
