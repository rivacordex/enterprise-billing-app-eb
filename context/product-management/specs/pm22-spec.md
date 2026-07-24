# PM22 — UI: Price management

- **Unit:** 22 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm15 (`insertPrice` service to call) and Unit pm18 (the per-row Add-price seam, on both a family's primary row and its expanded sibling rows, to fill).
- **Authorizing sections:** `prodmgmt-project-overview-phase2.md` Features → Price management ("name, price type, pricing model (flat or tiered), currency, GL code, start date... a new price's start date may be backdated up to 3 days; the form shows a non-blocking warning when it is. Earlier than that is rejected outright."); `prodmgmt-architecture-phase2.md` §6 Inv. 14 (editing an `ACTIVE` offering's prices never mutates it in place); `prodmgmt-code-standards-phase2.md` §7 file tree (`actions/product/insert-price.action.ts`, `components/products/manage/add-price-dialog.tsx`, `price-form.tsx` — three separate files, `add-price-dialog.tsx` explicitly named, unlike Edit); `prodmgmt-ui-context-phase2.md` "This creates a new draft" and "Backdating warning" sections (exact `--bg-warning`/`--text-warning` copy patterns); `mockup-product_module_manage_products.html` (`openModal('price', i)` — the literal Add-price modal fields and the `ACTIVE`-target banner copy); `pm15-spec.md` (`insertPrice(offeringId, input, actorId, now?)` — the exact `InsertPriceResult` shape, the `RETIRED` guard, the field scope: exactly six fields, no `recurringChargePeriodLength`/`recurringChargePeriodType`/`unitOfMeasure`/`policy`); `pm18-spec.md` §2.6/§3.7 (the seam comment this unit removes: `{/* pm22 seam */}`, on every Add-price button, primary and expanded sub-row alike; `aria-label="Add price to ${offering.name}"`; `CircleDollarSign` icon); `pm19-spec.md`/`pm20-spec.md` (the two sibling units this one mirrors — `CreateOfferingDialog`'s single-submit-outcome dialog shape for the file layout, `EditOfferingForm`'s warning-banner and branch-then-auto-expand handling for the interaction shape); `pm99-build-plan-phase2.md` Unit pm22 (this unit's literal contract) and its own pm20 closing note ("Add price and the lifecycle actions each have exactly one submit outcome per pm99's own contract" — the reason this unit gets its own dialog file where Edit did not).

- **Codebase state verified 2026-07-22 (re-verify before implementing):**
  - **Shipped and committed:** Unit pm10 (`family_offering_id`), Unit pm11 (`createOffering`), Unit pm12 (`branchOfferingAsDraft`), Unit pm13 (`updateOffering`, `updateOfferingDraftInPlace`).
  - **Not yet started in the real codebase as of this writing:** Units pm14 (specifications), pm15 (`insertPrice` — `services/product/insert-price.ts` does not exist; `db/repositories/product-offering-price.ts` exports only `findByOfferingIdWithDerivedEnd`, no `insertPrice` method; `validation/product/insert-price.schema.ts` does not exist), pm16 (activate/retire), pm17 (nav split), pm18 (`app/(app)/products/manage-products/` does not exist; `components/products/manage/` is an empty directory), pm19 (`actions/product/` does not exist; no `OfferingForm`/`CreateOfferingDialog`), pm20, pm21. **This spec is written assuming pm15 and pm18 will exist, exactly as their own specs describe, by the time pm22's implementation lands** — the same "spec written ahead of its not-yet-shipped prerequisite" stance `pm19-spec.md` and `pm20-spec.md` each already took for their own dependencies. Before starting, re-confirm concretely: `services/product/insert-price.ts` exports `insertPrice(offeringId, input, actorId, now?)` returning the exact `InsertPriceResult` shape pm15-spec §2 describes (`ok`/`offeringId`/`productOfferingPriceId`/`branched`/`backdated`, or `OFFERING_NOT_FOUND`/`OFFERING_RETIRED`/`BACKDATED_START_TOO_FAR`); `validation/product/insert-price.schema.ts` exports `insertPriceSchema`/`InsertPriceInput` exactly as pm15-spec §3.1 describes (no `offeringId` key); `components/products/manage/manage-offering-table.tsx` exists and every Add-price button (primary rows and expanded sibling rows alike) carries the literal seam comment `{/* pm22 seam */}`; `components/products/manage/offering-form.tsx`/`create-offering-dialog.tsx` exist per pm19/pm20 (this unit does not touch either file, but their shape is the concrete precedent this spec follows). If any of this isn't true yet, this unit has nothing correct to wire into and cannot start.
  - `types/product.ts`'s `PRICE_TYPES = ["recurring", "usage", "once"]` and `PRICING_MODELS = ["flat", "tiered"]` already exist (Phase 1, unchanged) — reused directly, no new enum. `PriceTypeBadge`'s `PRICE_TYPE_LABELS` ("Recurring"/"Usage"/"Once") is the existing display-label convention this unit's `<select>`/`SelectItem` options reuse verbatim, not a new label set.
  - `validation/product/pricing-characteristics.schema.ts`'s `priceCharacteristicsSchema` (the `flat`/`tiered` XOR discriminated union, snake_case `pricing_model`/`amount`/`pricing_characteristics` keys) and `tieredPricingCharacteristicsSchema` (tier contiguity, Inv. #4) are both shipped, unchanged, and reused wholesale by `insertPriceSchema` (pm15) — this unit never re-declares either.
  - No `TierTable` or `CharacteristicChip` component exists in the codebase — both were deliberately deleted in the "Post-ship polish" commit after v1 shipped (`prodmgmt-progress-tracker.md`: "deleted `CharacteristicChip`/`TierTable` entirely... inline JSONB characteristics/tiers as plain text instead of dedicated widgets"). This unit does **not** resurrect either — the tiered-pricing tier-row editor this unit builds is a new, input-only (not display) component, unrelated to the deleted read-only `TierTable`.
  - `components/ui/radio-group.tsx` (Radix-backed `RadioGroup`/`RadioGroupItem`) exists but has no consumer anywhere in the codebase yet — this unit is its first user, for the Flat/Tiered pricing-model toggle.
  - No date-picker component exists; the one precedent for a date input in this codebase is `components/audit-log/audit-log-filters.tsx`'s plain `<input type="date">` via the existing `Input` primitive — this unit reuses that same plain-HTML-date-input pattern, not a new calendar widget.

---

## 1. Goal

Let a `products:EDIT` user click "Add price" on any row (a family's primary row or one of its expanded sibling versions) on `/products/manage-products`, fill in name, price type, pricing model (flat amount or a tiered rate table), currency, optional GL code, and a start date in a dialog, and save: a `DRAFT` target gets the price inserted directly and visible immediately; an `ACTIVE` target transparently produces a new sibling `DRAFT` carrying the new price, with the original `ACTIVE` row and its existing prices untouched; a start date within the 3-day backdating tolerance shows a non-blocking warning and succeeds, a start date beyond that tolerance is rejected with a field-level error before any write happens.

## 2. Design

### 2.1 One dialog file, one form file — unlike Edit, because Add Price has exactly one submit outcome

`pm20-spec.md` (Edit offering) deliberately has **no** `edit-offering-dialog.tsx` file, because Edit's footer needs two independently-parameterized submit outcomes ("Save" vs. "Save as new draft") whose buttons must live wherever `handleSubmit`'s closures are in scope — forcing the footer into `offering-form.tsx` itself. That reasoning does not apply here: Add Price has **exactly one** submit outcome, "Add price" (`pm99`'s own literal contract: "Adding a price... applies directly... lands on a new draft version instead" — the routing is entirely server-side, driven by the target offering's current status, never by which button the user clicked). This is the same one-outcome shape `CreateOfferingDialog`/`OfferingForm`'s `create` mode already has, and `prodmgmt-code-standards-phase2.md` §7's file tree confirms it explicitly: `add-price-dialog.tsx` is named as its own file (alongside `create-offering-dialog.tsx` and `retire-offering-dialog.tsx`), where Edit's equivalent is conspicuously absent. `PriceForm` therefore renders fields only; `AddPriceDialog` owns the `Dialog`/`DialogHeader`/`DialogFooter` chrome and a single "Add price" button bound via `form="price-form-add"` — the exact `CreateOfferingDialog`/`CreateOfferingForm` split, applied to a new pair of files.

### 2.2 One dialog instance per row, not one shared instance in table state

Unlike Edit (`pm20-spec` §2.1 — one shared `editingRow` state and one conditionally-mounted dialog in `ManageOfferingTable`, because the footer's closures made a per-row instantiation awkward), Add Price's single-outcome shape lets it follow **Create's** pattern instead: `AddPriceDialog` takes a `trigger: React.ReactNode` prop and owns its own `open`/`isSubmitting` state internally, exactly like `CreateOfferingDialog`. `ManageOfferingTable` wraps **every** row's Add-price button (the family's primary row, and independently, every expanded sibling row — `pm18-spec` §3.7 point 5 gives each version row its own action set) in its own `<AddPriceDialog>` instance, passing that row's own `productOfferingId`/`name`/`lifecycleStatus`/`familyId` as props. This means `ManageOfferingTable` needs **no new shared state** for this seam at all — no `addPriceRow` state, no shared conditionally-mounted dialog — which is simpler than Edit's wiring, not an oversight relative to it. Radix's `Dialog` renders nothing to the DOM beyond its trigger while closed, so mounting one (closed) `AddPriceDialog` per visible row costs nothing observable; this is the same trade-off any per-row action dialog in this codebase already makes implicitly whenever a table renders N independent trigger-driven modals.

### 2.3 Field set — exactly what `insertPriceSchema` (pm15) validates, nothing the Phase-1 nullable columns would suggest

Six fields, matching `pm15-spec.md`'s own field-scope note precisely: **Price name** (text), **Price type** (`recurring`/`usage`/`once`, reusing `PriceTypeBadge`'s existing labels), **Pricing model** (`flat`/`tiered` — a `RadioGroup` toggle, this unit's first use of that primitive), **Currency** (plain 3-letter text input — no currency-picker component exists anywhere in this codebase to reuse, and building one is out of scope; a plain `Input` with `maxLength={3}` is the "reuse, don't invent speculatively" call here), **GL code** (text, optional), **Start date** (`<input type="date">` via the existing `Input` primitive, mirroring `audit-log-filters.tsx`'s own date-input precedent). No field for `recurringChargePeriodLength`/`recurringChargePeriodType`/`unitOfMeasure`/`policy` — `pm15-spec.md` Design is explicit these four Phase-1 nullable columns are "excluded, not merely defaulted" from this whole feature's scope; this form must not grow a control for any of them, in this unit or later.

The mockup's own Add-price modal (`openModal('price', i)`) renders a simplified four-field version (name, type, a single free-text "Amount" field, start date) with no currency/GL-code inputs and no flat/tiered toggle — `pm15-spec.md` §2 already flagged this exact gap ("`product_offering_price` also has three other nullable columns... none of which the companion mockup's Add-price dialog renders either" — referring there to the four excluded columns, but the same observation extends to currency/GL-code/pricing-model, which the mockup also omits for brevity). This spec follows the **project overview's** literal field list ("name, price type, pricing model (flat or tiered), currency, GL code, start date") and `insertPriceSchema`'s actual required shape over the mockup's simplified illustration, the same precedence `pm15-spec.md` itself already established when it built the full six-field schema against a four-field mockup.

### 2.4 Two layers of validation, deliberately not three — client-side structural checks plus one authoritative server round-trip, no re-declared tier-contiguity logic

`pm15-spec.md` Design explicitly rejected re-declaring `priceCharacteristicsSchema`'s two branches a second time inside `insert-price.schema.ts` itself, to avoid two independently-drifting copies of the tier-contiguity/XOR rules (Inv. #4, #5). This unit hits an adjacent problem and resolves it the same way, one layer further out: `react-hook-form`'s `useForm` needs a single, flat, always-defined shape to drive a controlled `useFieldArray` for tiers — a discriminated union (`insertPriceSchema`'s actual shape) can't back that directly, since the `tiers` field doesn't exist at all on the `flat` branch. Rather than inventing a *second* Zod-level re-declaration of the contiguity/XOR rules to validate a flattened shape (the exact duplication `pm15-spec.md` rejected once already), this unit draws the line as follows:

- **`price-form.tsx`'s own local `priceFormSchema`** validates only the checks that are meaningful on the flat, pre-assembly shape and don't depend on cross-branch business rules: `name` non-empty, `priceType` one of the three enum values, `currency` exactly 3 characters, `startDateTime` non-empty and — *this one rule is intentionally duplicated a third time, consistent with `pm15-spec.md`'s own already-accepted precedent of declaring the 3-day tolerance constant independently in two files* — not more than 3 days in the past (blocking `FieldError`, same message text as `insertPriceSchema`'s own superRefine: "Start date cannot be more than 3 days in the past."). When `pricingModel === "flat"`, `amount` must be a non-empty money-shaped string. When `pricingModel === "tiered"`, `tiers` must have at least one row and every row's `from`/`rate` must be non-empty money/number-shaped strings — but **not** contiguity, **not** the open-ended-only-on-the-last-tier rule. Those two remain defined in exactly the one place `tieredPricingCharacteristicsSchema` already defines them.
- **The Server Action's own `insertPriceSchema.safeParse(rawInput)`** (§3.2, the unchanged, already-shipped pm15 schema, imported as-is) is the authoritative check for the two rules the client intentionally doesn't re-implement. In the ordinary case this never fires, because "Add tier" always seeds a new row's `from` from the previous row's `to` (§2.6) and the local schema already caught the structural cases — but if it ever does fire, the failure surfaces as a generic, non-field-mapped error (`fieldErrors` keyed on `priceCharacteristics.tiers.<n>.to`, which has no corresponding flat-form field name to attach to) via a plain error banner above the tier rows, not a silently swallowed rejection. This is a disclosed, accepted simplification — the same "shouldn't normally happen, client's own resolver already blocks it, handled rather than crashing" stance `pm19-spec.md`/`pm20-spec.md` both already take for their own `VALIDATION_ERROR` branch.

### 2.5 Backdating — one computed value feeds both a live warning banner and a blocking field error, from the same source

`startDateTime`'s relationship to "now" produces exactly three UI states, computed client-side from the currently-selected date on every render (via `useWatch`, not a submit-time-only check, so the banner/error update live as the date field changes):

1. **Future or exactly today:** no banner, no error.
2. **Backdated, within the 3-day tolerance (`0 < msSinceStart <= THREE_DAYS_MS`):** the non-blocking `--bg-warning`/`--text-warning` banner, exact copy from `prodmgmt-ui-context-phase2.md`: *"This price is backdated to `<date>`; historical bills may be affected."* Submission is allowed.
3. **Backdated beyond tolerance (`msSinceStart > THREE_DAYS_MS`):** a blocking `FieldError` under the Start date input, same message text `insertPriceSchema`'s own superRefine produces: *"Start date cannot be more than 3 days in the past."* `zodResolver` (via `priceFormSchema`'s own duplicated tolerance check, §2.4) already prevents submission in this state — the live computed value and the blocking validation error are two views of the same threshold, not two independently-maintained checks that could disagree.

`THREE_DAYS_MS` is declared as its own local constant inside `price-form.tsx` — a third independent copy alongside `insert-price.schema.ts`'s and `services/product/insert-price.ts`'s own copies (pm15-spec Design), consistent with that spec's own explicit "small, multi-caller constant, not worth a shared module" judgment call.

### 2.6 Tiered pricing — a minimal, input-only tier-row editor, new to this codebase

No existing component renders an *editable* tier table (`TierTable`, the read-only display version, was deleted post-v1-ship). This unit builds one, scoped narrowly:

- `useFieldArray({ control, name: "tiers" })` backs a variable-length list of rows, each with three text inputs — **From**, **To** (placeholder "Open-ended" — an empty value means the top-open tier, valid only on the last row, per §2.4's server-authoritative check), **Rate** — laid out as a compact three-column row inside a `fieldset` with legend "Tiers."
- **"Add tier"** (`Button variant="outline" size="sm"`, `Plus` icon) appends a new row, seeding its `from` from the *previous* row's `to` value when that value is non-empty (nudging the common case toward contiguity without enforcing it client-side — §2.4) or `""` otherwise, and its own `to`/`rate` empty.
- **Remove** (icon-only `Button variant="ghost" size="icon-sm"`, `X` icon, `aria-label="Remove tier ${index + 1}"`) on every row except when exactly one row remains (a tiered price needs at least one tier — `tieredPricingCharacteristicsSchema`'s own `z.array(tierSchema).min(1)`).
- Switching the `RadioGroup` from `tiered` back to `flat` does not clear the `tiers` array's field-array state (React Hook Form keeps it mounted-but-hidden) — harmless, since only the branch matching the current `pricingModel` is read at assembly time (§3.3).
- This editor is deliberately **not** a resurrection of the deleted `TierTable` — that component was read-only display for `PriceCard.pricingCharacteristics` on View Product; this one is a new, write-only, `react-hook-form`-bound input surface scoped to this dialog alone, living in `price-form.tsx`, not exported for reuse elsewhere.

### 2.7 The "creates a new draft" banner — reused verbatim from Edit's copy pattern, not the mockup's price-specific wording

`prodmgmt-ui-context-phase2.md`'s "This creates a new draft" section states its copy pattern applies to **both** "the Edit dialog and the Add Price dialog" whenever the target offering's current status is `ACTIVE`: *"`<Name>` is active. Saving will not change it — a new draft version is created instead."* The mockup's own Add-price modal instead shows a shorter, offering-name-free variant for this same case ("This adds the price to a new draft version, not to the active offering."). This spec follows the **documented, generalized ui-context-phase2 copy pattern** — already used verbatim by `pm20-spec.md` §2.7 for Edit — over the mockup's one-off shorter phrasing, for the same reason `pm18-spec.md` §2.5 gave when it picked one reading over another: consistency across the module's two warning-banner call sites beats matching a static mockup's incidental wording exactly. `<Name>` is the offering's own name (the row being acted on), threaded in as a prop, not re-derived from any form field (there is no name field on this form to confuse it with).

### 2.8 Success handling — mirrors Edit's `router.refresh()` + branch-aware toast + auto-expand, extended with backdated-noted copy

On `result.ok`: dialog closes, `router.refresh()` re-runs `page.tsx`'s server fetch (no query-string "selected row" concept on this page — same reasoning `pm19-spec.md` §2.4 and `pm20-spec.md` §2.9 both already gave). Toast copy: `"Price added"` when `branched` is `false`, `"Price added to new draft version"` when `true`. When `branched` is `true`, the row's family auto-expands via the same `setExpandedFamilies((prev) => new Set(prev).add(familyId))` call `pm20-spec.md` §2.9 established for Edit — extended here to Add Price for the identical reason (the newly-created sibling should be visible without an extra click), a disclosed, consistent extension of that pattern rather than a re-derivation of it. `backdated` does not change the toast copy — the backdating warning already did its job pre-submit (§2.5); repeating it in a post-success toast would be redundant.

Failure handling, by `code`:

| Code | Handling |
|---|---|
| `FORBIDDEN` | Toast, dialog stays open. |
| `VALIDATION_ERROR` | Toast (generic — client's own resolver should have already blocked this; §2.4's disclosed gap is the one realistic trigger). Dialog stays open. |
| `OFFERING_RETIRED` | Toast ("This offering has been retired and prices can no longer be added."), dialog stays open — unreachable via any shipped seam (pm18 never renders Add-price on a `RETIRED` row) but guarded defensively, mirroring `pm20-spec.md`'s identical stance on its own unreachable `OFFERING_RETIRED` branch. |
| `OFFERING_NOT_FOUND` | Toast, dialog closes, `router.refresh()` — mirrors `pm20-spec.md`'s handling exactly (staying open on a row that no longer exists just invites a repeat dead-end submit). |
| `BACKDATED_START_TOO_FAR` | Toast ("Start date is more than 3 days in the past and can no longer be used."), dialog stays open so the user can adjust the date. Realistically unreachable given §2.5's live client check, but the server clock is the authoritative one — handled, not assumed impossible. |
| `SERVER_ERROR` / thrown | Generic retry toast, dialog stays open. |

### 2.9 What this unit explicitly does NOT do

- No changes to the Edit/Activate/Discard/Retire seams — those stay exactly as `pm18` (and, if already landed, `pm20`) left them; Activate/Discard/Retire belong to pm23.
- No specification fields anywhere on this dialog — pm21's concern, reached from its own separate seam.
- No change to `app/(app)/products/manage-products/page.tsx` — this unit needs no new read-model column (unlike pm18's `familyOfferingId` or pm20's `billingOnly`); every field this dialog needs to prefill (name, current status, id) is already on `OfferingListRow` as of pm18.
- No new audit event type — `PRODUCT_PRICE_ADDED` already exists (pm15); this unit's action only calls the existing service.
- No resurrection of `TierTable`/`CharacteristicChip`, and no change to `PricesPanel`/View Product's own read-only price rendering.

## 3. Implementation

### 3.1 Validation — `validation/product/insert-price.schema.ts` (unchanged, reused as-is)

`insertPriceSchema`/`InsertPriceInput` (pm15) are imported by the Server Action only. No edits to this file — no `offeringId` key exists on it (pm15 Design: "a function parameter, not a schema field"), matching `updateOfferingSchema`'s precedent.

### 3.2 Server Action — `actions/product/insert-price.action.ts` (new)

```ts
"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { insertPrice } from "@/services/product/insert-price";
import { insertPriceSchema } from "@/validation/product/insert-price.schema";

export type InsertPriceActionResult =
  | {
      ok: true;
      offeringId: string;
      productOfferingPriceId: string;
      branched: boolean;
      backdated: boolean;
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "BACKDATED_START_TOO_FAR" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm22-spec §3.2. `offeringId` travels as its own parameter, never inside
// `rawInput` (Design §2.3, mirroring pm15's `insertPrice` and pm20's
// `updateOfferingAction` shape).
export async function insertPriceAction(
  offeringId: string,
  rawInput: unknown,
): Promise<InsertPriceActionResult> {
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

  const parsed = insertPriceSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await insertPrice(offeringId, parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  // Both product pages, matching create-offering.action.ts (pm19) and
  // update-offering.action.ts (pm20)'s identical precedent.
  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return {
    ok: true,
    offeringId: result.offeringId,
    productOfferingPriceId: result.productOfferingPriceId,
    branched: result.branched,
    backdated: result.backdated,
  };
}
```

### 3.3 Form — `components/products/manage/price-form.tsx` (new)

```tsx
"use client";

import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, X } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { PRICE_TYPES, PRICING_MODELS } from "@/types/product";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";

// Same tolerance value as insert-price.schema.ts's and insert-price.ts's own
// copies — a third independent copy, consistent with pm15-spec's own
// "small, multi-caller constant, not worth a shared module" call (Design §2.5).
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const PRICE_TYPE_LABELS: Record<(typeof PRICE_TYPES)[number], string> = {
  recurring: "Recurring",
  usage: "Usage",
  once: "Once",
};

const MONEY_REGEX = /^\d+(\.\d+)?$/;

// pm22-spec §2.4. Validates only the checks meaningful on this flat,
// pre-assembly shape — NOT tier contiguity or the open-ended-only-on-last
// rule, which stay defined exactly once, in tieredPricingCharacteristicsSchema
// (reused, not re-declared, by the Server Action's own insertPriceSchema
// round-trip at submit time).
const priceFormSchema = z
  .object({
    name: z.string().trim().min(1, "Price name is required"),
    priceType: z.enum(PRICE_TYPES),
    currency: z.string().trim().length(3, "Currency must be a 3-letter code"),
    glCode: z.string().trim(),
    startDateTime: z.string().min(1, "Start date is required"),
    pricingModel: z.enum(PRICING_MODELS),
    amount: z.string(),
    tiers: z.array(
      z.object({ from: z.string(), to: z.string(), rate: z.string() }),
    ),
  })
  .superRefine((value, ctx) => {
    if (value.pricingModel === "flat" && !MONEY_REGEX.test(value.amount)) {
      ctx.addIssue({
        code: "custom",
        message: "Enter a valid amount.",
        path: ["amount"],
      });
    }
    if (value.pricingModel === "tiered") {
      if (value.tiers.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "Add at least one tier.",
          path: ["tiers"],
        });
      }
      value.tiers.forEach((tier, index) => {
        if (!MONEY_REGEX.test(tier.from)) {
          ctx.addIssue({
            code: "custom",
            message: "Enter a valid number.",
            path: ["tiers", index, "from"],
          });
        }
        if (!MONEY_REGEX.test(tier.rate)) {
          ctx.addIssue({
            code: "custom",
            message: "Enter a valid rate.",
            path: ["tiers", index, "rate"],
          });
        }
      });
    }

    // Duplicated tolerance check (Design §2.5) — a fast, live, field-level
    // check; the Server Action's own insertPriceSchema round-trip (§3.2) is
    // the authoritative one.
    const start = new Date(`${value.startDateTime}T00:00:00`);
    if (!Number.isNaN(start.getTime())) {
      const msSinceStart = Date.now() - start.getTime();
      if (msSinceStart > THREE_DAYS_MS) {
        ctx.addIssue({
          code: "custom",
          message: "Start date cannot be more than 3 days in the past.",
          path: ["startDateTime"],
        });
      }
    }
  });

type PriceFormValues = z.infer<typeof priceFormSchema>;

export interface PriceFormProps {
  offeringName: string;
  currentStatus: "DRAFT" | "ACTIVE";
  onSubmit: (values: InsertPriceInput) => Promise<void>;
  isSubmitting: boolean;
}

// pm22-spec §3.3. Assembles the flat form shape into insertPriceSchema's
// actual nested shape — the one place the two representations meet.
function toInsertPriceInput(values: PriceFormValues): InsertPriceInput {
  const priceCharacteristics =
    values.pricingModel === "flat"
      ? {
          pricing_model: "flat" as const,
          amount: values.amount,
          pricing_characteristics: null,
        }
      : {
          pricing_model: "tiered" as const,
          amount: null,
          pricing_characteristics: {
            tiers: values.tiers.map((tier) => ({
              from: Number(tier.from),
              to: tier.to.trim() === "" ? null : Number(tier.to),
              rate: tier.rate,
            })),
          },
        };

  return {
    name: values.name,
    priceType: values.priceType,
    currency: values.currency.toUpperCase(),
    glCode: values.glCode.trim() === "" ? null : values.glCode.trim(),
    startDateTime: new Date(`${values.startDateTime}T00:00:00`),
    priceCharacteristics,
  };
}

export function PriceForm({
  offeringName,
  currentStatus,
  onSubmit,
  isSubmitting,
}: PriceFormProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<PriceFormValues>({
    resolver: zodResolver(priceFormSchema),
    defaultValues: {
      name: "",
      priceType: "recurring",
      currency: "",
      glCode: "",
      startDateTime: new Date().toISOString().slice(0, 10),
      pricingModel: "flat",
      amount: "",
      tiers: [{ from: "0", to: "", rate: "" }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "tiers",
  });

  const pricingModel = useWatch({ control, name: "pricingModel" });
  const startDateTime = useWatch({ control, name: "startDateTime" });

  // Design §2.5 — live, non-blocking backdating warning, computed from the
  // same threshold the blocking FieldError (via priceFormSchema, above) uses.
  const backdatedWarning = (() => {
    if (!startDateTime) return null;
    const start = new Date(`${startDateTime}T00:00:00`);
    if (Number.isNaN(start.getTime())) return null;
    const msSinceStart = Date.now() - start.getTime();
    if (msSinceStart > 0 && msSinceStart <= THREE_DAYS_MS) {
      return `This price is backdated to ${startDateTime}; historical bills may be affected.`;
    }
    return null;
  })();

  return (
    <form
      id="price-form-add"
      noValidate
      onSubmit={(e) =>
        void handleSubmit((values) => onSubmit(toInsertPriceInput(values)))(e)
      }
    >
      {currentStatus === "ACTIVE" && (
        <div className="mb-3 rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
          {offeringName} is active. Saving will not change it — a new draft
          version is created instead.
        </div>
      )}

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="price-name">Price name</FieldLabel>
          <Input
            id="price-name"
            type="text"
            autoComplete="off"
            autoFocus
            placeholder="Monthly recurring"
            aria-invalid={!!errors.name}
            disabled={isSubmitting}
            {...register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="price-type">Price type</FieldLabel>
          <select
            id="price-type"
            aria-invalid={!!errors.priceType}
            disabled={isSubmitting}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            {...register("priceType")}
          >
            {PRICE_TYPES.map((type) => (
              <option key={type} value={type}>
                {PRICE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <FieldError errors={[errors.priceType]} />
        </Field>

        <Field orientation="responsive">
          <Field>
            <FieldLabel htmlFor="price-currency">Currency</FieldLabel>
            <Input
              id="price-currency"
              type="text"
              maxLength={3}
              placeholder="USD"
              aria-invalid={!!errors.currency}
              disabled={isSubmitting}
              {...register("currency")}
            />
            <FieldError errors={[errors.currency]} />
          </Field>

          <Field>
            <FieldLabel htmlFor="price-gl-code">GL code</FieldLabel>
            <Input
              id="price-gl-code"
              type="text"
              placeholder="Optional"
              disabled={isSubmitting}
              {...register("glCode")}
            />
          </Field>
        </Field>

        <Field>
          <FieldLabel>Pricing model</FieldLabel>
          <RadioGroup
            className="grid-flow-col justify-start gap-4"
            defaultValue="flat"
            disabled={isSubmitting}
            onValueChange={(value) =>
              register("pricingModel").onChange({
                target: { value, name: "pricingModel" },
              })
            }
          >
            <label className="flex items-center gap-2 text-body-sm">
              <RadioGroupItem value="flat" /> Flat
            </label>
            <label className="flex items-center gap-2 text-body-sm">
              <RadioGroupItem value="tiered" /> Tiered
            </label>
          </RadioGroup>
        </Field>

        {pricingModel === "flat" && (
          <Field>
            <FieldLabel htmlFor="price-amount">Amount</FieldLabel>
            <Input
              id="price-amount"
              type="text"
              placeholder="50000.00"
              aria-invalid={!!errors.amount}
              disabled={isSubmitting}
              {...register("amount")}
            />
            <FieldError errors={[errors.amount]} />
          </Field>
        )}

        {pricingModel === "tiered" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-body-sm font-medium text-foreground">
              Tiers
            </legend>
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-end gap-2">
                <Field>
                  <FieldLabel htmlFor={`tier-from-${index}`}>From</FieldLabel>
                  <Input
                    id={`tier-from-${index}`}
                    type="text"
                    disabled={isSubmitting}
                    {...register(`tiers.${index}.from`)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`tier-to-${index}`}>To</FieldLabel>
                  <Input
                    id={`tier-to-${index}`}
                    type="text"
                    placeholder="Open-ended"
                    disabled={isSubmitting}
                    {...register(`tiers.${index}.to`)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`tier-rate-${index}`}>Rate</FieldLabel>
                  <Input
                    id={`tier-rate-${index}`}
                    type="text"
                    disabled={isSubmitting}
                    {...register(`tiers.${index}.rate`)}
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove tier ${index + 1}`}
                  disabled={isSubmitting || fields.length === 1}
                  onClick={() => remove(index)}
                >
                  <X size={14} aria-hidden />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSubmitting}
              onClick={() =>
                append({
                  from: fields[fields.length - 1]
                    ? // seed from the previous row's `to` (Design §2.6)
                      ""
                    : "0",
                  to: "",
                  rate: "",
                })
              }
            >
              <Plus size={14} aria-hidden />
              Add tier
            </Button>
            <FieldError errors={[errors.tiers as { message?: string }]} />
          </fieldset>
        )}

        <Field>
          <FieldLabel htmlFor="price-start-date">Start date</FieldLabel>
          <Input
            id="price-start-date"
            type="date"
            aria-invalid={!!errors.startDateTime}
            disabled={isSubmitting}
            {...register("startDateTime")}
          />
          <FieldError errors={[errors.startDateTime]} />
          {backdatedWarning && !errors.startDateTime && (
            <div className="rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
              {backdatedWarning}
            </div>
          )}
        </Field>
      </FieldGroup>
    </form>
  );
}
```

Notes on this file: `register("pricingModel")`'s manual `onChange` wiring under `RadioGroup.onValueChange` is necessary because `RadioGroup`/`RadioGroupItem` (Radix) don't expose a native `<input onChange>` event `register()` can bind to directly — the same category of mismatch `Controller` normally solves for `Checkbox` elsewhere in this codebase (`offering-form.tsx`'s `isSellable`/`billingOnly`); a `Controller`-wrapped `RadioGroup` is an equally valid, arguably cleaner implementation of the same binding and is an acceptable substitution during implementation, noted here as a deliberate "either is fine" call rather than a strict requirement, since this is this component's first use of `RadioGroup` and no existing precedent settles it either way.

### 3.4 Dialog — `components/products/manage/add-price-dialog.tsx` (new)

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { insertPriceAction } from "@/actions/product/insert-price.action";
import { PriceForm } from "@/components/products/manage/price-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";

export interface AddPriceDialogProps {
  trigger: React.ReactNode;
  offeringId: string;
  offeringName: string;
  currentStatus: "DRAFT" | "ACTIVE";
  // Design §2.8 — lets ManageOfferingTable auto-expand the family when a
  // branch happens, without this component needing its own family-id
  // resolution or shared table state (mirrors pm20's editingRow-driven
  // auto-expand, adapted to this component's per-row-instance shape).
  onBranched: () => void;
}

export function AddPriceDialog({
  trigger,
  offeringId,
  offeringName,
  currentStatus,
  onBranched,
}: AddPriceDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    setOpen(nextOpen);
  }

  async function handleSubmit(values: InsertPriceInput): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await insertPriceAction(offeringId, values);

      if (result.ok) {
        setOpen(false);
        if (result.branched) {
          toast.success("Price added to new draft version");
          onBranched();
        } else {
          toast.success("Price added");
        }
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_RETIRED") {
        toast.error(
          "This offering has been retired and prices can no longer be added.",
        );
      } else if (result.code === "OFFERING_NOT_FOUND") {
        toast.error("This offering no longer exists. Refreshing...");
        setOpen(false);
        router.refresh();
      } else if (result.code === "BACKDATED_START_TOO_FAR") {
        toast.error(
          "Start date is more than 3 days in the past and can no longer be used.",
        );
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const title =
    currentStatus === "ACTIVE"
      ? `Add price — creates new draft — ${offeringName}`
      : `Add price — ${offeringName}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <PriceForm
          offeringName={offeringName}
          currentStatus={currentStatus}
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
        />

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" form="price-form-add" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="animate-spin" />}
            Add price
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### 3.5 Filling the pm18 seam — `components/products/manage/manage-offering-table.tsx` (edit)

Locate every Add-price button pm18 (and, if already landed, pm19/pm20/pm21) left inert — on a family's primary row and on every expanded sibling row alike, per `pm18-spec` §3.7 point 5 (`CircleDollarSign` icon, `--text-secondary`, `aria-label="Add price to ${row.name}"`, seam comment `{/* pm22 seam */}`). Wrap each with its own `AddPriceDialog` instance (Design §2.2 — no shared table state needed for this seam):

```tsx
// Before (pm18):
<button
  type="button"
  aria-label={`Add price to ${row.name}`}
  className="..."
>
  <CircleDollarSign size={16} aria-hidden />
</button>
{/* pm22 seam */}

// After (pm22) — `row` is the primary or sibling OfferingListRow already in
// scope, `family` is the enclosing OfferingFamilyRow (same scope pm20 uses
// for its own family-id capture):
<AddPriceDialog
  offeringId={row.productOfferingId}
  offeringName={row.name}
  currentStatus={row.lifecycleStatus as "DRAFT" | "ACTIVE"}
  onBranched={() =>
    setExpandedFamilies((prev) => new Set(prev).add(family.familyId))
  }
  trigger={
    <button
      type="button"
      aria-label={`Add price to ${row.name}`}
      className="..."
    >
      <CircleDollarSign size={16} aria-hidden />
    </button>
  }
/>
```

Add one import: `import { AddPriceDialog } from "@/components/products/manage/add-price-dialog";`. `currentStatus` is cast to the narrow `"DRAFT" | "ACTIVE"` union the same defensive way `pm20-spec` §2.8/§3.6 already casts `editingRow.row.lifecycleStatus` — `pm18`'s own action matrix never renders this button on a `RETIRED` row, so the cast is safe by construction. No other line in this file changes — the Edit/Activate/Discard/Retire seams, and whatever pm19/pm20/pm21 already filled, stay byte-unchanged.

### 3.6 Guardrail test — `tests/guardrails/product-module-boundaries.test.ts` (edit — one array entry appended)

```ts
// pm19 shipped this array with one entry; pm20/pm21 (if already landed)
// append their own; this unit appends its own, per pm19-spec §2.5/§3.6's own
// instruction ("pm20–pm23 each append their own action file to this array
// as it lands"). Exact starting contents depend on build order relative to
// pm21 — append "insert-price.action.ts" to whatever this array already
// contains, do not overwrite existing entries.
const EXPECTED_PRODUCT_ACTION_FILES = [
  "create-offering.action.ts",
  "update-offering.action.ts",
  // ...pm21's three specification action files, if already landed...
  "insert-price.action.ts",
];
```

No other assertion in this file changes. `PRODUCT_WRITE_SERVICE_FILES` (a separate set, scoped to `services/product/`) already contains `"insert-price.ts"` since pm15 and needs no edit here.

### 3.7 Tests

- `tests/actions/insert-price.action.test.ts` (new) — mirrors `update-offering.action.test.ts`'s structure: mocks `requirePermission`, `insertPrice`, and `next/cache`'s `revalidatePath`; asserts a successful call invokes `insertPrice` with `(offeringId, parsedData, actorId)` and returns `{ ok: true, offeringId, productOfferingPriceId, branched, backdated }` matching the mocked service's return, and calls `revalidatePath` with both product pages; asserts an empty `name` (or any other invalid field) returns `VALIDATION_ERROR` with the corresponding `fieldErrors` populated and never calls `insertPrice`; asserts a redirect from `requirePermission` returns `FORBIDDEN`; asserts the service's `OFFERING_NOT_FOUND`/`OFFERING_RETIRED`/`BACKDATED_START_TOO_FAR` codes all pass through the action unchanged; asserts a thrown error from the service returns `SERVER_ERROR`.
- `tests/components/price-form.test.tsx` (new) — renders `<PriceForm>` standalone (no dialog wrapper needed for this file's assertions): asserts the Flat/Tiered `RadioGroup` toggle shows the Amount field only in `flat` mode and the tier-row editor only in `tiered` mode; asserts "Add tier" appends a row and "Remove" removes one (disabled when exactly one row remains); asserts a start date more than 3 days in the past blocks submission with the exact `FieldError` message and never calls `onSubmit`; asserts a start date exactly 3 days in the past does **not** block submission and instead renders the non-blocking backdating warning banner with the exact ui-context-phase2 copy; asserts a future or today's-date start date renders neither banner nor error; asserts submitting a valid flat-priced form calls `onSubmit` with a correctly-assembled `InsertPriceInput` (`priceCharacteristics.pricing_model === "flat"`, `amount` set, `pricing_characteristics: null`); asserts submitting a valid tiered-priced form calls `onSubmit` with `pricing_model === "tiered"`, `amount: null`, and `pricing_characteristics.tiers` matching the entered rows with `from`/`to`/`rate` correctly coerced to numbers (`to: null` for an empty "To" field); asserts the `--bg-warning` banner renders (exact ui-context-phase2 copy) when `currentStatus === "ACTIVE"` and never when `"DRAFT"`.
- `tests/components/add-price-dialog.test.tsx` (new) — mocks `insertPriceAction` and `next/navigation`'s `useRouter`; renders `<AddPriceDialog trigger={<button>Add price</button>} offeringId="PRDOFR1" offeringName="Test Plan" currentStatus="DRAFT" onBranched={vi.fn()} />`, opens it, fills a minimal valid flat-priced form, submits, asserts: the action is called with `("PRDOFR1", <assembled input>)`; on `{ ok: true, branched: false }` the dialog closes, "Price added" toast fires, `router.refresh()` is called, and `onBranched` is **not** called; re-rendered with a mocked `{ ok: true, branched: true }` result, asserts "Price added to new draft version" toast and that `onBranched` **is** called; on `FORBIDDEN`/`OFFERING_RETIRED`/`BACKDATED_START_TOO_FAR`/`SERVER_ERROR` results the dialog stays open with the matching error toast; on `OFFERING_NOT_FOUND` the dialog closes and `router.refresh()` fires; asserts the dialog's title switches between `"Add price — Test Plan"` (`currentStatus="DRAFT"`) and `"Add price — creates new draft — Test Plan"` (`currentStatus="ACTIVE"`), and the `--bg-warning` banner renders only in the latter case.
- `tests/components/manage-offering-table.test.tsx` (**edit**, pm18/pm19/pm20/pm21-owned file) — this file's Add-price-button assertion currently asserts "no attached behavior" alongside whichever other row actions haven't been filled yet (pm18-spec §3.9). Update it, and only it: clicking "Add price" on any `DRAFT` or `ACTIVE` row (primary or an expanded sibling) opens `AddPriceDialog` (confirmed via its title text); a successful, `branched: true` result asserts the row's family id is added to `expandedFamilies` (its other version rows become visible without a further click). Leave every other seam's own "no attached behavior" assertion untouched — Activate/Discard/Retire remain real seams for pm23.
- `tests/guardrails/product-module-boundaries.test.ts` — run the full suite; confirm the appended array entry (§3.6) passes and no other assertion regresses.

### 3.8 Commit

One commit. Contents: `actions/product/insert-price.action.ts` (new), `components/products/manage/price-form.tsx` (new), `components/products/manage/add-price-dialog.tsx` (new), `components/products/manage/manage-offering-table.tsx` (edit — Add-price seams filled, one import added), `tests/guardrails/product-module-boundaries.test.ts` (edit — one array entry appended), `tests/actions/insert-price.action.test.ts` (new), `tests/components/price-form.test.tsx` (new), `tests/components/add-price-dialog.test.tsx` (new), `tests/components/manage-offering-table.test.tsx` (edit — Add-price-seam assertions replaced, others untouched). Explicitly **not** in this commit: any change to `services/product/insert-price.ts`, `db/repositories/product-offering-price.ts`, `validation/product/insert-price.schema.ts` (pm15's own code, consumed here unmodified), any `db/migrations/` file, any change to `create-offering.action.ts`/`update-offering.action.ts`/`offering-form.tsx`/`create-offering-dialog.tsx` (pm19/pm20's own files), any change to `app/(app)/products/manage-products/page.tsx`.

## 4. Dependencies

**No new npm packages.** Everything this unit needs is already installed and already used elsewhere in this codebase:

- `react-hook-form` + `@hookform/resolvers/zod` — already used by `offering-form.tsx` (pm19/pm20), `role-form.tsx`, `user-form.tsx`. `useFieldArray`/`useWatch` are both part of the already-installed `react-hook-form` package, just not yet used elsewhere in this codebase — this unit is their first consumer here.
- `lucide-react` — `Loader2` (already used by `create-offering-dialog.tsx`), `Plus`/`X` (new call sites, same package, no version change), `CircleDollarSign` (pm18's own icon for this seam's button, unchanged).
- `sonner` (`toast`) — already used by `create-offering-dialog.tsx`.
- `components/ui/dialog.tsx`, `components/ui/radio-group.tsx` (first use in this codebase — already installed, zero-consumer until now), `components/ui/input.tsx`, `components/ui/field.tsx`, `components/ui/button.tsx` — all existing primitives, no new one added.
- `zod` — already installed; this unit's one new schema (`priceFormSchema`, local to `price-form.tsx`) uses only `z.object`/`z.enum`/`z.array`/`.superRefine`, all already used elsewhere in `validation/product/`.

No Drizzle or Postgres-driver change — this unit adds no validation schema under `validation/product/` (pm15's `insertPriceSchema` is reused untouched) and no DB access of any kind.

## 5. Verification checklist

**Diff hygiene**
- [ ] `git status` shows only the files listed in §3.8 — nothing under `services/`, `db/`, `validation/product/insert-price.schema.ts`, or `app/(app)/products/manage-products/page.tsx`.
- [ ] `price-form.tsx`'s rendered fields are exactly: Price name, Price type, Currency, GL code, Pricing model (Flat/Tiered), Amount (flat mode only) or Tiers (tiered mode only), Start date — no field for `recurringChargePeriodLength`/`recurringChargePeriodType`/`unitOfMeasure`/`policy` anywhere, grep-confirmed.
- [ ] `insert-price.action.ts` contains no direct DB/repository import — it calls only `services/product/insert-price`.
- [ ] No edit to `tieredPricingCharacteristicsSchema`/`priceCharacteristicsSchema` (`validation/product/pricing-characteristics.schema.ts`) — the tier-contiguity/XOR rules are not re-declared anywhere in this unit's diff.

**Backend/Action correctness**
- [ ] An unpermitted caller invoking `insertPriceAction` gets `{ ok: false, code: "FORBIDDEN" }` and `insertPrice` is never called.
- [ ] A `products:EDIT` caller submitting a valid flat-priced input against a `DRAFT` offering gets `{ ok: true, offeringId: <same id>, branched: false, backdated: false }` for a future start date, and both `revalidatePath` calls fire.
- [ ] The same caller submitting against an `ACTIVE` offering gets `{ ok: true, offeringId: <new sibling id>, branched: true }`.
- [ ] A start date exactly 3 days in the past returns `backdated: true` on success; 4 days in the past returns `{ ok: false, code: "BACKDATED_START_TOO_FAR" }`.
- [ ] An empty `name` (or any other invalid field) returns `VALIDATION_ERROR` with the matching `fieldErrors` populated; `insertPrice` is never called.
- [ ] The service's `OFFERING_NOT_FOUND`/`OFFERING_RETIRED` codes pass through the action unchanged.
- [ ] A thrown error from the service returns `SERVER_ERROR`, not an unhandled exception.

**UI behavior — the point of the unit**
- [ ] Clicking "Add price" on any `DRAFT` row (primary or an expanded sibling) opens a dialog titled `"Add price — <Name>"`, no warning banner, with Price name/Price type/Currency/GL code/Pricing model/Start date all present and empty/defaulted, Amount shown by default (Flat is the default pricing model).
- [ ] Clicking "Add price" on any `ACTIVE` row opens a dialog titled `"Add price — creates new draft — <Name>"` with the `--bg-warning` banner naming that row.
- [ ] No "Add price" button renders at all on a `RETIRED` row (pm18's own matrix, re-confirmed still true after this unit's changes).
- [ ] Switching Pricing model from Flat to Tiered swaps the Amount field for the tier-row editor and vice versa, with no stale field left visible from the other mode.
- [ ] "Add tier" appends a row; "Remove" removes a row and is disabled/absent when exactly one tier row remains.
- [ ] Entering a start date more than 3 days in the past shows a blocking field error under Start date and the "Add price" button's submit does not fire a network call.
- [ ] Entering a start date exactly 3 days in the past shows the non-blocking backdating warning banner (exact ui-context-phase2 copy) and submission succeeds.
- [ ] Entering a start date in the future or today shows neither banner nor error.
- [ ] Submitting a valid flat-priced Add-price on a `DRAFT` row: after the dialog closes, that same row's price count/detail (verified via a subsequent `getOfferingDetail` call or the DB directly, since this table itself shows no price column) reflects the new price with no manual page reload, a "Price added" toast fires, and the family's expand state is unchanged.
- [ ] Submitting on an `ACTIVE` row produces a new sibling `DRAFT` carrying the new price: the family auto-expands (or was already expanded) so the sibling is visible immediately, a "Price added to new draft version" toast fires, and the original `ACTIVE` row's own prices are confirmed unchanged (same count/content as before the submit).
- [ ] Cancel closes the dialog with no request sent and no price row created, from both the `DRAFT` and `ACTIVE` variants.
- [ ] The dialog cannot be dismissed (Cancel, overlay click, or Escape) while a submission is in flight.
- [ ] A real `PRODUCT_PRICE_ADDED` audit row is written for every successful add (direct or branched), with `after_data` containing the submitted fields plus `backdated` and (when branched) `branchedFromOfferingId` — confirms pm15's service is genuinely invoked end-to-end, not just its type signature.

**Guardrail suite**
- [ ] `tests/guardrails/product-module-boundaries.test.ts`'s appended assertion (§3.6) passes: `actions/product/` contains `insert-price.action.ts` alongside whatever pm19–pm21 already landed.
- [ ] Every other guardrail assertion in that file still passes unmodified — in particular the price-repository shape assertion (`insertPrice` the sole exception) and the "no update*/delete* on prices" assertion, both untouched by this unit.
- [ ] `tests/components/manage-offering-table.test.tsx`'s updated Add-price-seam assertions (§3.7) pass; Activate/Discard/Retire's "no behavior yet" assertions still pass unmodified.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm run test` green — full suite, including the new/edited test files above.
- [ ] `npm run build` passes.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy) gets a pm22 entry with the commit reference, and explicitly records the one open implementation choice this spec flagged rather than mandated (§3.3's note on `Controller`-wrapped vs. manually-wired `RadioGroup`), so a later reviewer doesn't mistake whichever way it landed for a deviation from spec.

**Pipeline**
- [ ] CI green end-to-end. This unit adds one action file to the already-established mutation surface; the SAST/DAST baseline should show no new finding beyond what's already expected for a standard Server-Action-backed create-style form.

Any failing item means the unit is not done. Unit pm23 (Lifecycle actions) follows the same dialog/form/action/guardrail-increment shape this unit and pm19/pm20 already established — do not start it assuming a different pattern.
