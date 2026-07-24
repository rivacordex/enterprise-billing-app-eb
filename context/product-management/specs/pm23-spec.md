# PM23 — UI: Lifecycle Actions (Activate / Retire / Discard)

- **Unit:** 23 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm16 (`activateOffering`/`retireOffering` services to call) and Unit pm18 (the per-row Activate/Discard/Retire seams — on both a family's primary row and every expanded sibling row — to fill). This is the last of the five UI units (pm19–pm23); once it lands, every seam `pm18` left inert is filled and `pm24` (ship gate) has nothing left to wait on except its own guardrail rewrites.
- **Authorizing sections:** `prodmgmt-project-overview-phase2.md` Core User Flow step 6 ("clicks 'Activate.' The draft becomes `ACTIVE` and billable. (If this family already had an active version, that version is retired automatically in the same action, labeled in the audit trail as superseded.)"), step 10 ("clicks 'Discard' on that draft row. It moves to `RETIRED` directly — a soft delete, not a row deletion — and disappears from the default view"), Features → Lifecycle transitions ("`DRAFT → ACTIVE`: requires at least one price row and all mandatory specifications resolved... `ACTIVE → RETIRED` (\"Retire\") and `DRAFT → RETIRED` (\"Discard\")... `RETIRED` is terminal"), and Success Criteria ("Attempting to activate a `DRAFT` with no prices, or with unresolved mandatory specifications, is rejected with a specific error and the offering stays `DRAFT`" / "both disappear from \"View Product\"'s default filter, and the audit log distinguishes \"retired\" from \"discarded\" from \"superseded\""); `prodmgmt-architecture-phase2.md` §4 (permission table: Activate is part of the `products:EDIT`-gated "create/edit/branch/activate" row; Retire/Discard is its own `products:DELETE`-gated row) and §6 Inv. 13 (single-active-per-family, enforced transactionally by `pm16`, not this unit's concern — this unit only has to render the result); `prodmgmt-code-standards-phase2.md` §1 rule 11 ("Discard and Retire are the same repository call with different audit events... Do not fork this into two repository methods"), §4 ("New binding component names... `RetireOfferingDialog` (its copy/title switches between \"Retire\" and \"Discard draft\" based on the target's status — one component, not two)"), §6 rule 13 (reason captured in the audit payload, not a schema field), §7 file tree (`actions/product/activate-offering.action.ts`, `retire-offering.action.ts` — "handles both Retire and Discard" — and `components/products/manage/retire-offering-dialog.tsx`; no separate form file named for either dialog), §8 permission map (`RetireOfferingDialog` row: `actions/product/retire-offering.action.ts` : `products:DELETE`); `prodmgmt-ui-context-phase2.md` "Row action buttons" table (icon/color/visibility per status), "Discard vs. Retire dialog" section (the exact title/body/confirm-button copy table and the shared `AlertDialog` danger pattern, `alert-triangle`/`--text-danger`, optional "Reason (optional)" field), and "Activate confirmation" section (plain, non-danger `Dialog`, accent-filled confirm button, exact body copy, same optional Reason field); `mockup-product_module_manage_products.html` (icon-only 28px row-action buttons); `pm16-spec.md` (`activateOffering(offeringId, input, actorId)` → `ActivateOfferingResult` with `supersededOfferingId`; `retireOffering(offeringId, input, actorId)` → `RetireOfferingResult` with `eventType`; the two named precondition failure codes `NO_PRICE_ROWS`/`SPECIFICATIONS_NOT_RESOLVED`; `activateOfferingSchema`/`retireOfferingSchema`, both `{ reason?: string }`); `pm18-spec.md` §2.3 (RETIRED-primary families stay visible on Manage Products, muted, "No actions — retired" — the exact reason this unit's own "disappears from the default view" language, below, is scoped to View Product, not this page) and §2.6/§3.7 (the row-action matrix, the literal seam comment `{/* pm23 seam */}` on every Activate/Discard/Retire button, primary and expanded-sibling rows alike, and each button's exact `aria-label` text); `pm19-spec.md`/`pm22-spec.md` (the per-row dialog-instance pattern and the `EXPECTED_PRODUCT_ACTION_FILES` incremental-guardrail convention this unit continues); `pm20-spec.md`/`pm22-spec.md` (the family auto-expand-on-mutation convention this unit extends to supersession); `components/roles/delete-role-dialog.tsx` (the closest existing precedent for an `AlertDialog`-based destructive confirmation with an inline business-rejection `Alert`, reused near-verbatim for `RetireOfferingDialog`); `components/customers/status-transition-control.tsx` (the closest existing precedent for a plain, non-`react-hook-form` `Textarea`-backed optional reason field driving a Server Action); `pm99-build-plan-phase2.md` Unit pm23 (this unit's literal contract).

- **Codebase state verified 2026-07-22 (re-verify before implementing):**
  - **Shipped and committed:** Unit pm10 (`family_offering_id` column), Unit pm11 (`insertOffering`), Unit pm12 (`branchOfferingAsDraft`), Unit pm13 (`updateOfferingDraftInPlace`, `services/product/update-offering.ts`).
  - **Not yet shipped in the real codebase as of this writing:** Unit pm14 (`db/repositories/product-specification.ts` exports only `findByOfferingId` — no `insertSpecification`/`updateSpecification`/`deleteSpecification` yet), Unit pm15 (`db/repositories/product-offering-price.ts` exports only `findByOfferingIdWithDerivedEnd` — no `insertPrice` yet), Unit pm16 (no `activateOffering`, `retireOffering`, or `findActiveInFamily` anywhere in `db/repositories/product-offering.ts`; `types/audit.ts`'s `AUDIT_EVENT_TYPES` ends at `"PRODUCT_OFFERING_BRANCHED"` — the four event types this unit's services write, `PRODUCT_OFFERING_ACTIVATED`/`_SUPERSEDED`/`_RETIRED`/`_DISCARDED`, do not exist yet), Unit pm17 (`components/admin-nav.tsx` still shows a single "Product Offering" item — no "View Product"/"Manage Products" split), Unit pm18 (`app/(app)/products/` contains only `product-offering/` — no `manage-products/` directory at all; `components/products/manage/` is an empty directory; `types/product.ts`'s `OfferingListRow` has no `familyOfferingId` field and there is no `OfferingFamilyRow` type), and Units pm19–pm22 (`actions/product/` does not exist as a directory yet at all — no action file of any kind has shipped).
  - **This spec is written assuming pm16 and pm18 — its two direct dependencies — will exist exactly as their own specs describe by the time pm23's implementation lands**, the same stance `pm16-spec.md`, `pm18-spec.md`, `pm19-spec.md`, and `pm22-spec.md` each already took for their own not-yet-shipped prerequisites. Before starting, re-confirm concretely: `services/product/activate-offering.ts` exports `activateOffering(offeringId, input, actorId)` returning the exact `ActivateOfferingResult` union `pm16-spec.md` §2 describes; `services/product/retire-offering.ts` exports `retireOffering(offeringId, input, actorId)` returning the exact `RetireOfferingResult` union; `validation/product/activate-offering.schema.ts` and `retire-offering.schema.ts` both export a schema whose only field is `reason` (optional, trimmed, max 500); `components/products/manage/manage-offering-table.tsx` exists and every Activate/Discard/Retire button (primary rows and expanded sibling rows alike) carries the literal seam comment `{/* pm23 seam */}` with the `aria-label`s `pm18-spec.md` §2.6/§3.7 names. If any of this isn't true yet, this unit has nothing correct to wire into and cannot start.
  - **Whether pm19, pm20, pm21, and/or pm22 have already landed by the time this unit starts is not settled by the dependency graph** — `pm99`'s graph shows all five UI units (pm19–pm23) branching independently off their own backend dependency and converging only at `pm24`; none of pm19–pm22 is a prerequisite of this unit. If any have landed, `actions/product/` and `EXPECTED_PRODUCT_ACTION_FILES` (in `tests/guardrails/product-module-boundaries.test.ts`) will already contain their action files — this unit only ever appends its own two, never assumes a specific starting count. If none have landed, `actions/product/` does not exist yet at all and this unit is the one that creates it (mirroring how `pm19-spec.md` §2.5 handled being first, in that scenario).
  - `components/ui/alert-dialog.tsx` exports `AlertDialog`/`AlertDialogTrigger`/`AlertDialogContent`/`AlertDialogHeader`/`AlertDialogTitle`/`AlertDialogDescription`/`AlertDialogFooter`/`AlertDialogCancel`/`AlertDialogAction` — all already used by `components/roles/delete-role-dialog.tsx` and `components/users/delete-user-dialog.tsx`. `components/ui/textarea.tsx` exists and is already used by `components/customers/status-transition-control.tsx` (a plain, uncontrolled-by-react-hook-form `Textarea` bound to local `useState`, feeding a Server Action). `components/ui/dialog.tsx` (plain, non-alert `Dialog`) is already used by `create-offering-dialog.tsx`/`add-price-dialog.tsx`. No new `components/ui/*` primitive is needed by this unit.

---

## 1. Goal

Let a `products:EDIT` user click "Activate" on any `DRAFT` row (primary or an expanded sibling) and, after confirming an optional reason, flip it to `ACTIVE` — automatically retiring whichever other version in its family was previously `ACTIVE`, visible in the same table without a page reload — or receive a specific, on-screen reason when the draft has no prices or an unresolved mandatory specification; and let a `products:DELETE` user click "Discard" on a `DRAFT` row or "Retire" on an `ACTIVE` row and, through one shared dialog whose title, body copy, and confirm button switch on the target's current status, move it to `RETIRED` with an optional reason — both actions removing the offering from **View Product's** default filter while it remains visible, muted, and action-less on **Manage Products** itself, per `pm18`'s own design.

## 2. Design

### 2.1 Two Server Actions, two dialogs — `retire-offering.action.ts` and `RetireOfferingDialog` each handle both Retire and Discard, `activate-offering.action.ts` and a new `ActivateOfferingDialog` are Activate's alone

Exactly `pm99`'s own file list: `actions/product/activate-offering.action.ts`, `actions/product/retire-offering.action.ts`, plus "the Activate confirmation dialog and `retire-offering-dialog.tsx` (one component...)". `code-standards-phase2.md` §7's file tree names `retire-offering-dialog.tsx` explicitly but names no separate file for Activate's dialog or for either dialog's form — unlike `PriceForm`/`OfferingForm`, neither lifecycle dialog gets a standalone form component in this unit. Both dialogs are single, self-contained files: a plain `Dialog` (`ActivateOfferingDialog`, new) and an `AlertDialog` (`RetireOfferingDialog`, new), each owning its own trivial one-field body directly, rather than splitting out a `LifecycleReasonForm` neither `pm99` nor `code-standards-phase2.md` §4's binding-component-name list ever mentions. This mirrors `components/roles/delete-role-dialog.tsx`, which likewise has no separate form file for its own (unlabeled) confirmation UI.

### 2.2 The Reason field is a plain, `useState`-backed `Textarea`, not a `react-hook-form` + `zodResolver` form — a deliberate departure from Create/Edit/Add-price's pattern

Every prior form-bearing dialog in this phase (`OfferingForm`, `PriceForm`, `SpecificationForm` once it ships) is `react-hook-form` + `zodResolver`-driven, because each has multiple fields with real client-side validation rules worth centralizing in a resolver. Neither lifecycle dialog has that shape: `activateOfferingSchema`/`retireOfferingSchema` (`pm16-spec.md` §3.1/§3.2) are each a single optional, trimmed, 500-char-capped string — there is no cross-field rule, no enum, no discriminated union, nothing a `zodResolver` would meaningfully centralize that a plain `maxLength={500}` attribute and the server's own authoritative `safeParse` don't already cover. `components/customers/status-transition-control.tsx` is the existing precedent for exactly this shape in this codebase: a plain `useState<string>` reason value, a `Textarea`, and a directly-invoked async handler — no `<form>` element, no `register()`, no resolver. Both of this unit's dialogs follow that precedent, matching `delete-role-dialog.tsx`'s own equally form-free `AlertDialog` structure (a plain `onClick`-driven confirm button, not a `type="submit"` bound to a `form="…"` id). This is a legitimate, disclosed alternative to the Create/Edit/Add-price shape, not an inconsistency — those three forms earn their `react-hook-form` weight from real per-field rules; these two dialogs would only be adding indirection around one already-trivial field.

### 2.3 Permission split: Activate is `products:EDIT`, Retire/Discard is `products:DELETE` — two different `requirePermission` calls, not one shared level

`prodmgmt-architecture-phase2.md` §4's table is explicit and easy to misread if skimmed: the row for "Manage Products (new: create/edit/branch/**activate**)" is gated at `products:EDIT`; a **separate** row, "Manage Products — retire / discard," is gated at `products:DELETE`. `pm16-spec.md`'s own Goal line ("Let a `products:EDIT`/`DELETE` caller...") states this permissively/generically at the service layer (the service itself performs no permission check — that's the action's job, per every other unit's convention), which is why this spec calls it out precisely here: `activateOfferingAction` calls `requirePermission(PERMISSIONS.PRODUCTS, LEVELS.EDIT)`; `retireOfferingAction` calls `requirePermission(PERMISSIONS.PRODUCTS, LEVELS.DELETE)`. A user with `EDIT` but not `DELETE` can activate but gets `FORBIDDEN` attempting to discard or retire — this is the intended, spec'd behavior (`code-standards-phase2.md` §8's permission map draws the identical split), not a bug to reconcile away, and is the one behavioral difference in this unit's two Server Actions beyond which service each calls.

### 2.4 Per-row dialog instances, not shared table state — mirrors `AddPriceDialog` (pm22), not `EditOfferingForm`'s (pm20) shared `editingRow` pattern

Both of this unit's dialogs have exactly one submit outcome each (Activate always means "attempt to activate this specific draft"; Retire/Discard always means "attempt to retire this specific offering") — the same single-outcome shape `pm22-spec.md` §2.1/§2.2 already used to justify following `CreateOfferingDialog`'s per-row-instance pattern over `pm20`'s shared-state one. `ManageOfferingTable` wraps every row's Activate button in its own `<ActivateOfferingDialog>` and every row's Discard/Retire button in its own `<RetireOfferingDialog>` (primary row and every expanded sibling row alike, per `pm18-spec.md` §3.7 point 5's "each version row has its own action set"), passing that row's own `productOfferingId`/`name`/`lifecycleStatus` as props. No new shared state is added to `ManageOfferingTable` for either seam beyond the one `setExpandedFamilies` call both already rely on (§2.7) — which already exists in that file since `pm18`.

### 2.5 Activation's precondition failures get an inline `Alert`, not a toast — the one place this unit departs from `pm19`/`pm20`/`pm22`'s toast-only failure handling

`prodmgmt-project-overview-phase2.md`'s own Success Criteria names two specific, expected (not defensive-edge-case) rejection reasons: no price rows, and an unresolved mandatory specification. Unlike `pm22`'s `BACKDATED_START_TOO_FAR` (a real but comparatively rare user error, handled with a toast that keeps the dialog open), these two codes are the literal, everyday reason a `products:EDIT` user will click Activate and have it fail — a transient toast is easy to miss, especially since the dialog stays open and the user's most likely next action is reading *why* before deciding what to do next (add a price? go resolve a spec?). This spec follows `components/roles/delete-role-dialog.tsx`'s own precedent instead: its one *expected*, non-defensive business rejection (`ROLE_IN_USE`) renders as a persistent `Alert variant="destructive"` inside the dialog, not a toast, while its edge-case codes (`ROLE_NOT_FOUND`, `SEEDED_ROLE`) still get the same treatment for simplicity — this unit narrows that further, using the inline `Alert` only for the two codes the project overview itself calls out as named, expected failures, and toasts for every other (unreachable-via-any-shipped-seam) code, matching `pm20`/`pm22`'s stance on their own unreachable branches.

### 2.6 Auto-expand on supersession — extends `pm20`/`pm22`'s auto-expand-on-branch convention to a new trigger: a sibling being retired, not a new sibling being created

`pm20-spec.md` §2.9 and `pm22-spec.md` §2.8 both auto-expand a family when their own action creates a **new** sibling `DRAFT` the user should see without an extra click. Activation never creates a new row — but when `supersededOfferingId` is non-null, an *existing* sibling's status just changed (from `ACTIVE` to `RETIRED`) in the same transaction, and `pm99`'s own visible-result contract for this unit is explicit that this must be "visibly, in the same table" — i.e., without requiring the user to already have the family expanded. `ActivateOfferingDialog` therefore takes an `onSuperseded: () => void` prop, called only when `result.supersededOfferingId` is non-null, wired by `ManageOfferingTable` to the identical `setExpandedFamilies((prev) => new Set(prev).add(family.familyId))` call `pm20`/`pm22` already established — a disclosed, consistent extension of that pattern to a new trigger (supersession rather than branching), not a re-derivation of it. `RetireOfferingDialog` needs no equivalent prop: retiring or discarding never creates or exposes a new row to reveal.

### 2.7 "Disappears from the default view" — this unit's own read of a phrase that could otherwise be misapplied to the wrong page

`pm99-build-plan-phase2.md`'s own visible-result line for this unit says Discard/Retire "both remove the row from the default view via their distinctly-labeled dialogs." Read against `pm18-spec.md` §2.3 in isolation, this looks contradictory: Manage Products explicitly does **not** hide `RETIRED`-primary families — they stay visible, muted, with "No actions — retired" replacing the button row. The resolution is that "the default view" here is **View Product's**, not Manage Products' — `prodmgmt-project-overview-phase2.md`'s own Success Criteria settles this precisely: "both disappear from \"View Product\"'s default filter." View Product's Phase 1 filter already hides `RETIRED` by default (unchanged, `pm02`/`pm03`'s own design), and neither this unit nor any other in Phase 2 touches that filter. So: after a successful Retire or Discard, the affected row **stays visible** on Manage Products (now muted, actionless, per `pm18`'s own matrix — no code change needed there, this unit's dialogs simply trigger the `router.refresh()` that re-renders it in its new state) and **disappears** from View Product's own default-filtered list the next time that page is loaded. This spec flags this explicitly so an implementer doesn't "fix" Manage Products to hide the row, which would directly regress `pm18-spec.md`'s own, already-verified §2.3 behavior.

### 2.8 Result handling — Activate

| Result | Handling |
|---|---|
| `ok: true`, `supersededOfferingId: null` | Dialog closes, `toast.success("Offering activated")`, `router.refresh()`. |
| `ok: true`, `supersededOfferingId` non-null | Dialog closes, `toast.success("Offering activated — previous version retired")`, `onSuperseded()` fires (§2.6), `router.refresh()`. |
| `NO_PRICE_ROWS` | Inline `Alert` (§2.5): "This draft has no prices yet. Add at least one price before activating." Dialog stays open. |
| `SPECIFICATIONS_NOT_RESOLVED` | Inline `Alert`: "This draft has an unresolved mandatory specification. Set a value for every mandatory specification before activating." Dialog stays open. |
| `FORBIDDEN` | Toast, dialog stays open. |
| `OFFERING_NOT_FOUND` | Toast ("This offering no longer exists. Refreshing..."), dialog closes, `router.refresh()` — mirrors `pm20`/`pm22`'s identical handling of the same code. |
| `OFFERING_NOT_DRAFT` | Toast (generic) — unreachable via any shipped seam (`pm18` never renders Activate on a non-`DRAFT` row), guarded defensively. |
| `VALIDATION_ERROR` / `SERVER_ERROR` / thrown | Toast (generic), dialog stays open. |

### 2.9 Result handling — Retire / Discard

| Result | Handling |
|---|---|
| `ok: true`, `eventType: "PRODUCT_OFFERING_DISCARDED"` | Dialog closes, `toast.success("Draft discarded")`, `router.refresh()`. |
| `ok: true`, `eventType: "PRODUCT_OFFERING_RETIRED"` | Dialog closes, `toast.success("Offering retired")`, `router.refresh()`. |
| `FORBIDDEN` | Toast ("You don't have permission to do that." — the realistic case: an `EDIT`-only user attempting this, per §2.3), dialog stays open. |
| `OFFERING_RETIRED` | Toast ("This offering has already been retired."), dialog closes, `router.refresh()` — the target's already-terminal state makes staying open pointless (mirrors `pm22`'s `OFFERING_NOT_FOUND` reasoning). |
| `OFFERING_NOT_FOUND` | Toast ("This offering no longer exists. Refreshing..."), dialog closes, `router.refresh()`. |
| `VALIDATION_ERROR` / `SERVER_ERROR` / thrown | Toast (generic), dialog stays open. |

Note `eventType`, not the dialog's own `currentStatus` prop, drives the success toast — `pm16-spec.md`'s own Design explicitly returns `eventType` so a caller can "confirm which of 'Retired' / 'Discarded' actually occurred without re-deriving it from the offering's pre-call status itself"; this unit follows that guidance literally rather than assuming `currentStatus` and `eventType` must agree (in every reachable case they do, since `pm18` only ever renders this dialog with `currentStatus` matching the row's real status, but trusting the server's own answer is the more defensive, spec-literal choice).

### 2.10 What this unit explicitly does NOT do

- No change to the Edit/Add-price/Specification seams — those stay exactly as `pm18` (and, if already landed, `pm19`/`pm20`/`pm21`/`pm22`) left them.
- No change to `app/(app)/products/manage-products/page.tsx` — this unit needs no new read-model column; every field either dialog needs (`productOfferingId`, `name`, `lifecycleStatus`) is already on `OfferingListRow` as of `pm18`.
- No new audit event type — `PRODUCT_OFFERING_ACTIVATED`/`_SUPERSEDED`/`_RETIRED`/`_DISCARDED` all already exist (`pm16`); this unit's two actions only call the existing services.
- No change to View Product's own default-status filter — its "hide `RETIRED`" behavior is Phase 1, untouched (§2.7).
- No re-fork of `retireOffering` into two repository- or service-level methods for Retire versus Discard — one service, one action, one dialog component, exactly `code-standards-phase2.md` §1 rule 11's literal instruction, now extended one layer up to the UI: one `RetireOfferingDialog`, not two.

## 3. Implementation

### 3.1 Validation — `validation/product/activate-offering.schema.ts`, `retire-offering.schema.ts` (unchanged, reused as-is)

Both schemas (`pm16`) are imported by their respective Server Action only. No edits to either file — no `offeringId` key exists on either (a function parameter, not a schema field, per `pm16-spec.md` §2, matching every other mutation's convention in this phase).

### 3.2 Server Action — `actions/product/activate-offering.action.ts` (new)

```ts
"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { activateOffering } from "@/services/product/activate-offering";
import { activateOfferingSchema } from "@/validation/product/activate-offering.schema";

export type ActivateOfferingActionResult =
  | { ok: true; offeringId: string; supersededOfferingId: string | null }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT" }
  | { ok: false; code: "NO_PRICE_ROWS" }
  | { ok: false; code: "SPECIFICATIONS_NOT_RESOLVED" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm23-spec §3.2. Activate is gated at products:EDIT, not DELETE (Design
// §2.3; architecture-phase2 §4) — the only permission-level difference
// between this file and retire-offering.action.ts below.
export async function activateOfferingAction(
  offeringId: string,
  rawInput: unknown,
): Promise<ActivateOfferingActionResult> {
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

  const parsed = activateOfferingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await activateOffering(offeringId, parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  // Both product pages, matching every prior mutation action's precedent —
  // Manage Products shows the flipped status (and any superseded sibling)
  // directly; View Product's own list/detail queries are also invalidated
  // since a newly-ACTIVE offering now appears there under its default filter.
  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return {
    ok: true,
    offeringId: result.offeringId,
    supersededOfferingId: result.supersededOfferingId,
  };
}
```

### 3.3 Server Action — `actions/product/retire-offering.action.ts` (new)

```ts
"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { retireOffering } from "@/services/product/retire-offering";
import { retireOfferingSchema } from "@/validation/product/retire-offering.schema";

export type RetireOfferingActionResult =
  | {
      ok: true;
      offeringId: string;
      eventType: "PRODUCT_OFFERING_RETIRED" | "PRODUCT_OFFERING_DISCARDED";
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm23-spec §3.3. One action, one service call, handles both Retire and
// Discard (code-standards-phase2 §1 rule 11) — the caller never tells this
// action which of the two it "meant"; retireOffering (pm16) derives eventType
// entirely from the target's own status before the transaction opens. Gated
// at products:DELETE, not EDIT (Design §2.3; architecture-phase2 §4).
export async function retireOfferingAction(
  offeringId: string,
  rawInput: unknown,
): Promise<RetireOfferingActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.PRODUCTS,
      LEVELS.DELETE,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = retireOfferingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await retireOffering(offeringId, parsed.data, actorId);
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
    eventType: result.eventType,
  };
}
```

### 3.4 Dialog — `components/products/manage/activate-offering-dialog.tsx` (new)

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { activateOfferingAction } from "@/actions/product/activate-offering.action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export interface ActivateOfferingDialogProps {
  trigger: React.ReactNode;
  offeringId: string;
  offeringName: string;
  // Design §2.6 — lets ManageOfferingTable auto-expand the family so the
  // just-superseded sibling is visible without a further click. Called only
  // when the action's result carries a non-null supersededOfferingId.
  onSuperseded: () => void;
}

type PreconditionErrorCode = "NO_PRICE_ROWS" | "SPECIFICATIONS_NOT_RESOLVED";

// Design §2.5 — the two named, expected precondition failures get a
// persistent inline Alert, not a transient toast.
function preconditionMessage(code: PreconditionErrorCode): string {
  return code === "NO_PRICE_ROWS"
    ? "This draft has no prices yet. Add at least one price before activating."
    : "This draft has an unresolved mandatory specification. Set a value for every mandatory specification before activating.";
}

export function ActivateOfferingDialog({
  trigger,
  offeringId,
  offeringName,
  onSuperseded,
}: ActivateOfferingDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [preconditionError, setPreconditionError] =
    useState<PreconditionErrorCode | null>(null);

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    if (nextOpen) {
      setReason("");
      setPreconditionError(null);
    }
    setOpen(nextOpen);
  }

  async function handleActivateConfirm(): Promise<void> {
    setIsSubmitting(true);
    setPreconditionError(null);
    try {
      const result = await activateOfferingAction(offeringId, { reason });

      if (result.ok) {
        setOpen(false);
        if (result.supersededOfferingId) {
          toast.success("Offering activated — previous version retired");
          onSuperseded();
        } else {
          toast.success("Offering activated");
        }
        router.refresh();
      } else if (
        result.code === "NO_PRICE_ROWS" ||
        result.code === "SPECIFICATIONS_NOT_RESOLVED"
      ) {
        setPreconditionError(result.code);
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_NOT_FOUND") {
        toast.error("This offering no longer exists. Refreshing...");
        setOpen(false);
        router.refresh();
      } else {
        // OFFERING_NOT_DRAFT / VALIDATION_ERROR / SERVER_ERROR — unreachable
        // via any shipped seam (pm18 only ever renders Activate on a DRAFT
        // row); handled defensively, not assumed impossible, mirroring
        // pm20/pm22's identical stance on their own unreachable branches.
        toast.error("Something went wrong. Please try again.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Activate offering</DialogTitle>
        </DialogHeader>

        <p className="text-body-sm text-muted-foreground">
          <strong>{offeringName}</strong> will become billable once
          activated. Requires at least one price and all mandatory specs
          resolved. If another version of this product is currently active,
          it will be retired automatically.
        </p>

        {preconditionError && (
          <Alert variant="destructive">
            <AlertDescription>
              {preconditionMessage(preconditionError)}
            </AlertDescription>
          </Alert>
        )}

        <Field>
          <FieldLabel htmlFor="activate-reason">Reason (optional)</FieldLabel>
          <Textarea
            id="activate-reason"
            rows={2}
            maxLength={500}
            placeholder="Q3 rate refresh"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={isSubmitting}
          />
        </Field>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          {/* ui-context-phase2's "Activate confirmation" section: accent-
              filled — the one place besides "New offering" an accent button
              may appear, since the two never render in the same view. */}
          <Button
            type="button"
            disabled={isSubmitting}
            onClick={() => void handleActivateConfirm()}
            className="bg-[color:var(--action-cta-bg)]"
          >
            {isSubmitting && <Loader2 className="animate-spin" />}
            Activate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### 3.5 Dialog — `components/products/manage/retire-offering-dialog.tsx` (new)

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { retireOfferingAction } from "@/actions/product/retire-offering.action";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export interface RetireOfferingDialogProps {
  trigger: React.ReactNode;
  offeringId: string;
  offeringName: string;
  // "DRAFT" -> Discard copy; "ACTIVE" -> Retire copy (ui-context-phase2's
  // one-component-two-copy-states table). pm18's own action matrix never
  // renders this dialog's trigger on a RETIRED row, so no third case exists.
  currentStatus: "DRAFT" | "ACTIVE";
}

// ui-context-phase2.md "Discard vs. Retire dialog" — exact copy, verbatim.
const COPY = {
  DRAFT: {
    title: "Discard draft",
    body: (name: string): string =>
      `Discarding ${name} removes this draft — it never went live and this cannot be undone.`,
    confirmLabel: "Discard draft",
    successToast: "Draft discarded",
  },
  ACTIVE: {
    title: "Retire offering",
    body: (name: string): string =>
      `Retiring ${name} hides it from new billing selection. This cannot be undone.`,
    confirmLabel: "Retire offering",
    successToast: "Offering retired",
  },
} as const;

// pm23-spec §3.5. One component, two copy states — code-standards-phase2 §4
// ("its copy/title switches between 'Retire' and 'Discard draft' based on
// the target's status — one component, not two") and §1 rule 11 (one
// repository call, one service, now one dialog — no re-fork anywhere in
// this stack). Structurally near-identical to delete-role-dialog.tsx, with
// an added optional Reason field (Design §2.2).
export function RetireOfferingDialog({
  trigger,
  offeringId,
  offeringName,
  currentStatus,
}: RetireOfferingDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const copy = COPY[currentStatus];

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    if (nextOpen) setReason("");
    setOpen(nextOpen);
  }

  async function handleConfirm(): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await retireOfferingAction(offeringId, { reason });

      if (result.ok) {
        setOpen(false);
        // Design §2.9 — eventType, not the currentStatus prop, drives the
        // toast: the server's own answer to "which one actually happened."
        toast.success(
          result.eventType === "PRODUCT_OFFERING_DISCARDED"
            ? COPY.DRAFT.successToast
            : COPY.ACTIVE.successToast,
        );
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_RETIRED") {
        toast.error("This offering has already been retired.");
        setOpen(false);
        router.refresh();
      } else if (result.code === "OFFERING_NOT_FOUND") {
        toast.error("This offering no longer exists. Refreshing...");
        setOpen(false);
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

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {copy.body(offeringName)}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Field>
          <FieldLabel htmlFor="retire-reason">Reason (optional)</FieldLabel>
          <Textarea
            id="retire-reason"
            rows={2}
            maxLength={500}
            placeholder="Superseded by the new rate plan"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={isSubmitting}
          />
        </Field>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={isSubmitting}
            onClick={() => void handleConfirm()}
          >
            {isSubmitting && (
              <Loader2 size={14} className="mr-1 animate-spin" />
            )}
            {copy.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

### 3.6 Filling the pm18 seams — `components/products/manage/manage-offering-table.tsx` (edit)

Locate every Activate, Discard, and Retire button `pm18` (and, if already landed, `pm19`–`pm22`) left inert — on a family's primary row and on every expanded sibling row alike, per `pm18-spec.md` §2.6/§3.7 (`Check`/`--text-secondary` for Activate, `Trash2`/`--text-danger` for Discard, both `DRAFT`-only; `Archive`/`--text-danger` for Retire, `ACTIVE`-only; each with its own `aria-label` and the seam comment `{/* pm23 seam */}`). Wrap each with the matching dialog (Design §2.4 — no shared table state needed beyond the existing `expandedFamilies`/`setExpandedFamilies` pair):

```tsx
// Before (pm18), on a DRAFT row (row is the primary or a sibling
// OfferingListRow already in scope; family is the enclosing
// OfferingFamilyRow, same scope pm20/pm22 already capture):
<button
  type="button"
  aria-label={`Activate ${row.name}`}
  className="..."
>
  <Check size={16} aria-hidden />
</button>
{/* pm23 seam */}
<button
  type="button"
  aria-label={`Discard ${row.name}`}
  className="..."
>
  <Trash2 size={16} aria-hidden />
</button>
{/* pm23 seam */}

// After (pm23):
<ActivateOfferingDialog
  offeringId={row.productOfferingId}
  offeringName={row.name}
  onSuperseded={() =>
    setExpandedFamilies((prev) => new Set(prev).add(family.familyId))
  }
  trigger={
    <button
      type="button"
      aria-label={`Activate ${row.name}`}
      className="..."
    >
      <Check size={16} aria-hidden />
    </button>
  }
/>
<RetireOfferingDialog
  offeringId={row.productOfferingId}
  offeringName={row.name}
  currentStatus="DRAFT"
  trigger={
    <button
      type="button"
      aria-label={`Discard ${row.name}`}
      className="..."
    >
      <Trash2 size={16} aria-hidden />
    </button>
  }
/>
```

```tsx
// Before (pm18), on an ACTIVE row:
<button
  type="button"
  aria-label={`Retire ${row.name}`}
  className="..."
>
  <Archive size={16} aria-hidden />
</button>
{/* pm23 seam */}

// After (pm23):
<RetireOfferingDialog
  offeringId={row.productOfferingId}
  offeringName={row.name}
  currentStatus="ACTIVE"
  trigger={
    <button
      type="button"
      aria-label={`Retire ${row.name}`}
      className="..."
    >
      <Archive size={16} aria-hidden />
    </button>
  }
/>
```

Add two imports: `import { ActivateOfferingDialog } from "@/components/products/manage/activate-offering-dialog";` and `import { RetireOfferingDialog } from "@/components/products/manage/retire-offering-dialog";`. `currentStatus` is passed as a literal (`"DRAFT"` or `"ACTIVE"`), not cast from `row.lifecycleStatus` — unlike `pm20`/`pm22`'s narrowing casts, this unit's two call sites are already inside status-specific branches of the row-action matrix (the `DRAFT` action block and the `ACTIVE` action block are rendered separately, per `pm18`'s own matrix), so the literal is exact by construction, not a defensive cast. No other line in this file changes — this is the last of the five seam-filling units; once this edit lands, every button `pm18` originally rendered inert (New offering, Edit, Add price, Activate, Discard, Retire) has real behavior behind it.

### 3.7 Guardrail test — `tests/guardrails/product-module-boundaries.test.ts` (edit — one array extended)

```ts
// Whatever pm19–pm22 already appended (in whichever order they landed)
// stays untouched — this unit appends its own two entries, completing the
// full seven-file action set code-standards-phase2 §7 names.
const EXPECTED_PRODUCT_ACTION_FILES = [
  "create-offering.action.ts",
  "update-offering.action.ts",
  // ...pm21's three specification action files, if already landed...
  // ...pm22's insert-price.action.ts, if already landed...
  "activate-offering.action.ts",
  "retire-offering.action.ts",
];
```

No other assertion in this file changes. `PRODUCT_WRITE_SERVICE_FILES` already contains `"activate-offering.ts"`/`"retire-offering.ts"` since `pm16` and needs no edit here. Once this array contains all eight entries `code-standards-phase2.md` §7's file tree names (`create-offering`, `update-offering`, `activate-offering`, `retire-offering`, `create-specification`, `update-specification`, `delete-specification`, `insert-price`), `pm24`'s own final pass over this assertion has nothing left to add — only to formally confirm and take over ownership, per its own contract.

### 3.8 Tests

- `tests/actions/activate-offering.action.test.ts` (new) — mirrors `insert-price.action.test.ts`'s structure: mocks `requirePermission`, `activateOffering`, and `next/cache`'s `revalidatePath`; asserts a successful call invokes `activateOffering` with `(offeringId, parsedData, actorId)` and returns `{ ok: true, offeringId, supersededOfferingId }` matching the mocked service's return, and calls `revalidatePath` with both product pages; asserts `requirePermission` is called with `(PERMISSIONS.PRODUCTS, LEVELS.EDIT)` specifically (not `DELETE`); asserts a redirect from `requirePermission` returns `FORBIDDEN` without calling `activateOffering`; asserts the service's `OFFERING_NOT_FOUND`/`OFFERING_NOT_DRAFT`/`NO_PRICE_ROWS`/`SPECIFICATIONS_NOT_RESOLVED` codes all pass through the action unchanged; asserts a thrown error from the service returns `SERVER_ERROR`.
- `tests/actions/retire-offering.action.test.ts` (new) — same structure, mocking `retireOffering` instead: asserts `requirePermission` is called with `(PERMISSIONS.PRODUCTS, LEVELS.DELETE)` specifically (not `EDIT`) — this is the one assertion that most directly guards Design §2.3's permission split from silently regressing to a shared level; asserts a successful call returns `{ ok: true, offeringId, eventType }` matching the mocked service's return for both `PRODUCT_OFFERING_RETIRED` and `PRODUCT_OFFERING_DISCARDED` fixture cases; asserts the service's `OFFERING_NOT_FOUND`/`OFFERING_RETIRED` codes pass through unchanged; asserts a thrown error returns `SERVER_ERROR`.
- `tests/components/activate-offering-dialog.test.tsx` (new) — mocks `activateOfferingAction` and `next/navigation`'s `useRouter`; renders `<ActivateOfferingDialog trigger={<button>Activate</button>} offeringId="PRDOFR1" offeringName="Test Plan" onSuperseded={vi.fn()} />`, opens it, confirms with an empty reason, asserts the action is called with `("PRDOFR1", { reason: "" })`; on `{ ok: true, supersededOfferingId: null }` the dialog closes, "Offering activated" toast fires, `router.refresh()` is called, and `onSuperseded` is **not** called; re-rendered with a mocked `{ ok: true, supersededOfferingId: "PRDOFR2" }` result, asserts "Offering activated — previous version retired" toast and that `onSuperseded` **is** called; on `NO_PRICE_ROWS`/`SPECIFICATIONS_NOT_RESOLVED` results the dialog stays open and the exact inline `Alert` copy from §3.4 renders (not a toast); on `FORBIDDEN`/`OFFERING_NOT_DRAFT`/`VALIDATION_ERROR`/`SERVER_ERROR` results the dialog stays open with a toast; on `OFFERING_NOT_FOUND` the dialog closes and `router.refresh()` fires; asserts typing into the Reason field and confirming passes that exact string through to the action call; asserts the dialog cannot be dismissed while a submission is in flight.
- `tests/components/retire-offering-dialog.test.tsx` (new) — mocks `retireOfferingAction` and `next/navigation`'s `useRouter`; renders once with `currentStatus="DRAFT"` and asserts the title is "Discard draft", the body names the offering, and the confirm button reads "Discard draft"; renders again with `currentStatus="ACTIVE"` and asserts "Retire offering" throughout; confirms and asserts the action is called with `(offeringId, { reason })`; on `{ ok: true, eventType: "PRODUCT_OFFERING_DISCARDED" }` asserts the "Draft discarded" toast fires regardless of which `currentStatus` prop was passed (confirming `eventType`, not the prop, drives the toast per Design §2.9); on `{ ok: true, eventType: "PRODUCT_OFFERING_RETIRED" }` asserts "Offering retired"; on `FORBIDDEN`/`VALIDATION_ERROR`/`SERVER_ERROR` the dialog stays open with a toast; on `OFFERING_RETIRED`/`OFFERING_NOT_FOUND` the dialog closes and `router.refresh()` fires; asserts Cancel and the confirm button are both disabled while a submission is in flight.
- `tests/components/manage-offering-table.test.tsx` (**edit**, the pm18-owned file every prior UI unit has incrementally edited) — this is the **final** edit to this file's seam assertions: replace the remaining "no attached behavior" assertions for Activate, Discard, and Retire (primary rows and expanded sibling rows alike) with real-behavior assertions — clicking Activate on any `DRAFT` row opens `ActivateOfferingDialog` (confirmed via its title text "Activate offering"); clicking Discard on a `DRAFT` row opens `RetireOfferingDialog` titled "Discard draft"; clicking Retire on an `ACTIVE` row opens `RetireOfferingDialog` titled "Retire offering"; a successful, superseding Activate result asserts the family's `expandedFamilies` set gains the family id. After this edit, no row-action button or the "New offering" CTA in this file has a remaining "no attached behavior" assertion anywhere — every seam `pm18` originally left inert is now behaviorally tested.
- `tests/guardrails/product-module-boundaries.test.ts` — run the full suite; confirm the extended array (§3.7) passes and no other assertion regresses.

### 3.9 Commit

One commit. Contents: `actions/product/activate-offering.action.ts` (new), `actions/product/retire-offering.action.ts` (new), `components/products/manage/activate-offering-dialog.tsx` (new), `components/products/manage/retire-offering-dialog.tsx` (new), `components/products/manage/manage-offering-table.tsx` (edit — three seam categories filled across primary and sibling rows, two imports added), `tests/guardrails/product-module-boundaries.test.ts` (edit — one array extended by exactly two entries), `tests/actions/activate-offering.action.test.ts` (new), `tests/actions/retire-offering.action.test.ts` (new), `tests/components/activate-offering-dialog.test.tsx` (new), `tests/components/retire-offering-dialog.test.tsx` (new), `tests/components/manage-offering-table.test.tsx` (edit — remaining seam assertions replaced). Explicitly **not** in this commit: any change to `services/product/activate-offering.ts`/`retire-offering.ts`, `db/repositories/product-offering.ts`, `validation/product/activate-offering.schema.ts`/`retire-offering.schema.ts` (`pm16`'s own code, consumed here unmodified), any `db/migrations/` file, any change to `create-offering.action.ts`/`update-offering.action.ts`/`insert-price.action.ts`/any specification action file or their dialogs/forms (`pm19`–`pm22`'s own files), any change to `app/(app)/products/manage-products/page.tsx`, any change to View Product's default-status filter (Design §2.7).

## 4. Dependencies

**No new npm packages.** Everything this unit needs is already installed and already used elsewhere in this codebase:

- `lucide-react` — `Loader2` (already used by `create-offering-dialog.tsx`/`delete-role-dialog.tsx`); `Check`, `Trash2`, `Archive` are `pm18`'s own row-action icons, unchanged by this unit.
- `sonner` (`toast`) — already used by `create-offering-dialog.tsx`/`add-price-dialog.tsx`.
- `components/ui/dialog.tsx` (plain `Dialog`, for Activate) and `components/ui/alert-dialog.tsx` (`AlertDialog`, for Retire/Discard) — both already installed and already consumed elsewhere (`create-offering-dialog.tsx`; `delete-role-dialog.tsx`/`delete-user-dialog.tsx`).
- `components/ui/textarea.tsx` — already installed, already consumed by `components/customers/status-transition-control.tsx`.
- `components/ui/alert.tsx` (`Alert`/`AlertDescription`) — already installed, already consumed by `delete-role-dialog.tsx`.
- `components/ui/field.tsx`, `components/ui/button.tsx` — existing primitives, no new one added.

No `react-hook-form`, `@hookform/resolvers/zod`, or `zod` import is added by either new dialog (Design §2.2 — both use a plain `useState<string>` reason value, not a schema-backed form). No Drizzle or Postgres-driver change — this unit adds no validation schema (both of `pm16`'s are reused untouched) and no DB access of any kind.

## 5. Verification checklist

**Diff hygiene**
- [ ] `git status` shows only the files listed in §3.9 — nothing under `services/`, `db/`, `validation/product/activate-offering.schema.ts`/`retire-offering.schema.ts`, or `app/(app)/products/manage-products/page.tsx`.
- [ ] Neither `activate-offering-dialog.tsx` nor `retire-offering-dialog.tsx` imports `react-hook-form`, `@hookform/resolvers/zod`, or `zod` (Design §2.2, grep-confirmed).
- [ ] `activate-offering.action.ts` and `retire-offering.action.ts` each contain no direct DB/repository import — they call only their respective `services/product/*` export.
- [ ] `retire-offering-dialog.tsx` is a single component handling both Retire and Discard — grep confirms no second dialog component or file (e.g. `discard-offering-dialog.tsx`) exists anywhere in the diff.

**Backend/Action correctness — Activate**
- [ ] `activateOfferingAction` calls `requirePermission` with `(PERMISSIONS.PRODUCTS, LEVELS.EDIT)` — confirmed by source inspection or a mocked-call assertion, not just behaviorally.
- [ ] An unpermitted caller (no `products` grant, or `products:READ` only) gets `{ ok: false, code: "FORBIDDEN" }` and `activateOffering` is never called.
- [ ] A `products:EDIT` caller activating a `DRAFT` that meets both preconditions gets `{ ok: true, offeringId, supersededOfferingId: null }` when no sibling was active, or `{ ok: true, offeringId, supersededOfferingId: <siblingId> }` when one was, and both `revalidatePath` calls fire.
- [ ] The service's `NO_PRICE_ROWS`/`SPECIFICATIONS_NOT_RESOLVED`/`OFFERING_NOT_FOUND`/`OFFERING_NOT_DRAFT` codes all pass through the action unchanged.
- [ ] A thrown error from the service returns `SERVER_ERROR`, not an unhandled exception.

**Backend/Action correctness — Retire / Discard**
- [ ] `retireOfferingAction` calls `requirePermission` with `(PERMISSIONS.PRODUCTS, LEVELS.DELETE)` — confirmed directly, and a caller with `products:EDIT` but not `DELETE` gets `{ ok: false, code: "FORBIDDEN" }` (this is the concrete, executable proof of Design §2.3's permission split — a `products:EDIT`-only user must be able to activate but not discard/retire).
- [ ] A `products:DELETE` caller retiring an `ACTIVE` offering gets `{ ok: true, offeringId, eventType: "PRODUCT_OFFERING_RETIRED" }`; discarding a `DRAFT` gets `eventType: "PRODUCT_OFFERING_DISCARDED"` — both via the identical action code path, differing only in the mocked service's return.
- [ ] The service's `OFFERING_NOT_FOUND`/`OFFERING_RETIRED` codes pass through unchanged; both `revalidatePath` calls fire on success.
- [ ] A thrown error from the service returns `SERVER_ERROR`.

**UI behavior — Activate**
- [ ] Clicking "Activate" on any `DRAFT` row (primary or an expanded sibling) opens a dialog titled "Activate offering" naming that row, with an optional Reason textarea and Cancel/Activate buttons — Activate styled with `--action-cta-bg` (accent), matching the "New offering" CTA's treatment, not a danger/destructive style.
- [ ] Confirming on a draft meeting both preconditions, with no prior active sibling in its family: the row flips to `ACTIVE` without a manual page reload, a "Offering activated" toast fires, and the family's expand state is unchanged.
- [ ] Confirming on a draft meeting both preconditions, with an existing `ACTIVE` sibling: the target flips to `ACTIVE`, the sibling flips to `RETIRED`, **both changes are visible in the table without a further click** (the family auto-expands if it wasn't already) — a "Offering activated — previous version retired" toast fires. This is the unit's central visible-result claim; verify it against the real, mutated table state, not just the toast copy.
- [ ] Confirming on a draft with zero price rows shows the exact inline `Alert` copy from §3.4 ("This draft has no prices yet...") and the dialog stays open with the offering still `DRAFT` in the database.
- [ ] Confirming on a draft with an unresolved mandatory specification shows the exact inline `Alert` copy ("This draft has an unresolved mandatory specification...") and the dialog stays open, offering still `DRAFT`.
- [ ] Cancel closes the dialog with no request sent and no status change.
- [ ] The dialog cannot be dismissed (Cancel, overlay click, or Escape) while a submission is in flight.
- [ ] A real `PRODUCT_OFFERING_ACTIVATED` audit row is written for every successful activation, and a `PRODUCT_OFFERING_SUPERSEDED` row additionally appears whenever a sibling was retired — confirms `pm16`'s services are genuinely invoked end-to-end.

**UI behavior — Retire / Discard**
- [ ] Clicking "Discard" on any `DRAFT` row opens a dialog titled "Discard draft" with the exact body copy from §3.5 naming that row, a "Discard draft" confirm button styled `variant="destructive"`, and an optional Reason textarea.
- [ ] Clicking "Retire" on any `ACTIVE` row opens a dialog titled "Retire offering" with the exact body copy naming that row, and a "Retire offering" confirm button, same destructive styling.
- [ ] Confirming Discard on a `DRAFT`: the offering flips to `RETIRED` in the database; on Manage Products, the row **remains visible**, now muted with "No actions — retired" (per `pm18`'s own matrix — no change needed to see this, only confirming Design §2.7's reading holds); on View Product, the offering **no longer appears** under the default status filter.
- [ ] Confirming Retire on an `ACTIVE` offering: same status flip and same visibility split (visible-but-muted on Manage Products, hidden by View Product's default filter) as Discard, above.
- [ ] Cancel closes the dialog with no request sent and no status change, from both the `DRAFT` and `ACTIVE` variants.
- [ ] The dialog cannot be dismissed while a submission is in flight.
- [ ] A real `PRODUCT_OFFERING_RETIRED` audit row is written when the source was `ACTIVE`; a real `PRODUCT_OFFERING_DISCARDED` row is written when the source was `DRAFT` — confirmed as two distinct event types for the otherwise-identical `RETIRED` status outcome.
- [ ] A `products:EDIT`-only user (no `DELETE`) sees the Discard/Retire buttons render per `pm18`'s matrix (nav/render is permission-agnostic) but gets a `FORBIDDEN` toast and no status change when actually confirming — the page-level `EDIT` guard alone does not implicitly grant the retire/discard action.

**Guardrail suite**
- [ ] `tests/guardrails/product-module-boundaries.test.ts`'s extended assertion (§3.7) passes: `actions/product/` contains `activate-offering.action.ts` and `retire-offering.action.ts` alongside whatever `pm19`–`pm22` already landed, completing the full eight-file set `code-standards-phase2.md` §7 names.
- [ ] Every other guardrail assertion in that file still passes unmodified.
- [ ] `tests/components/manage-offering-table.test.tsx` contains **no remaining** "no attached behavior" assertion for any row action or the "New offering" CTA — this is the last unit that could have left one, and this checklist item is the direct proof none remain.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm run test` green — full suite, including the four new and one edited test file above.
- [ ] `npm run build` passes.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy, not the plan-folder mirror) gets a pm23 entry with the commit reference, explicitly noting that this is the final UI unit of the five (`pm19`–`pm23`) and that every `pm18` seam is now filled, so `pm24`'s ship-gate sweep can proceed without checking for any outstanding inert button.

**Pipeline**
- [ ] CI green end-to-end. This unit completes the product module's mutation surface (eight action files total); the SAST/DAST baseline should show no new finding beyond what's already expected for two standard Server-Action-backed confirmation flows, one of them destructive.

Any failing item means the unit is not done. Unit pm24 (ship gate) depends on this unit's Activate/Retire/Discard behavior — including the permission split (§2.3) and the visibility split between Manage Products and View Product (§2.7) — holding exactly as specified; do not start pm24 until every item above passes.
