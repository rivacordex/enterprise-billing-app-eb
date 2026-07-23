# PM19 — UI: Create Offering

- **Unit:** 19 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm11 (`createOffering` service to call) and Unit pm18 (the "New offering" CTA seam inside `ManageOfferingTable` to fill).
- **Authorizing sections:** `prodmgmt-project-overview-phase2.md` Core User Flow step 4 ("clicks 'New offering,' fills in name and flags... saves. A brand-new offering is created as the root of a new family, in `DRAFT` status") and Features → Offering management ("`is_bundle` is never shown or settable in this UI"); `prodmgmt-architecture-phase2.md` §1 (Server Action shape: `requirePermission` → `safeParse` → delegate to `services/product` → `revalidatePath`) and §2 (`actions/product/**` — "one Server Action file per mutation... no DB access in this layer"); `prodmgmt-code-standards-phase2.md` §1 rule 9 (`is_bundle` never user-editable, in any form, ever) and §7 (file tree: `actions/product/create-offering.action.ts`, `components/products/manage/create-offering-dialog.tsx`, `offering-form.tsx`); `prodmgmt-ui-context-phase2.md` §5 (`--action-cta-bg` reserved for "New offering," the only accent-filled primary action on that page); `mockup-product_module_manage_products.html` (the `create` modal's literal fields — Name text input, "Sellable" checkbox defaulting checked, "Billing only" checkbox defaulting unchecked, Cancel/"Save offering" buttons); `pm11-spec.md` (the `createOffering(input, actorId)` service this unit calls — no `isBundle` key, no `NAME_CONFLICT`-style failure branch, always `{ ok: true, offeringId }`); `pm18-spec.md` §2.4 (the CTA is rendered inside `ManageOfferingTable`, not the page header — it opens a dialog, not a navigation) and §2.6/§3.7 (the exact seam comment this unit removes: `{/* pm19 seam: onClick opens CreateOfferingDialog */}`); `components/roles/create-role-dialog.tsx` + `components/roles/role-form.tsx` (the closest existing "create-entity dialog + form" precedent — same `Dialog`/`DialogTrigger`/`react-hook-form`/`zodResolver` shape this unit reuses); `components/users/user-form.tsx` (the existing `Controller` + `Checkbox`/`onCheckedChange` pattern this unit's two boolean fields reuse, since `register()` alone doesn't fit a custom checkbox component); `pm99-build-plan-phase2.md` Unit pm19 (this unit's literal contract).

- **Codebase state verified 2026-07-22 (re-verify before implementing):**
  - **Shipped:** Unit pm10 (`family_offering_id` column), Unit pm11 (`validation/product/create-offering.schema.ts`, `productOfferingRepository.insertOffering`, `services/product/create-offering.ts` exporting `createOffering(input, actorId): Promise<{ ok: true; offeringId: string }>`, `PRODUCT_OFFERING_CREATED` in `types/audit.ts`), Unit pm12 (`branchOfferingAsDraft`).
  - **Not yet shipped as of this writing:** Unit pm17 (`components/admin-nav.tsx` still shows a single "Product Offering" item — no "View Product"/"Manage Products" split) and Unit pm18 (no `app/(app)/products/manage-products/` directory exists yet; `components/products/manage/` exists but is an **empty directory**). **This spec is written assuming pm17 and pm18 will exist by the time pm19's implementation lands**, per pm99's own dependency graph — but confirm before starting that `components/products/manage/manage-offering-table.tsx` actually exists and contains the literal seam comment `{/* pm19 seam: onClick opens CreateOfferingDialog */}` on its "New offering" button (pm18-spec §2.6/§3.7). If pm18 hasn't shipped yet, this unit has nothing to wire into and cannot start.
  - `actions/product/` does not exist yet. `tests/guardrails/product-module-boundaries.test.ts` currently has an assertion, `it("has no actions/product/ folder", ...)`, that expects this — **this unit is the one that makes that assertion obsolete** (see Design §2.5).
  - `validation/product/create-offering.schema.ts` already exists (shipped by pm11) and needs no changes: `{ name: string (trim, min 1, max 200), isSellable: boolean, billingOnly: boolean }`, no `isBundle` key.
  - No `OfferingForm` component exists yet anywhere in the codebase — this is a brand-new file.

---

## 1. Goal

Let a `products:EDIT` user click "New offering" on `/products/manage-products`, fill in name, sellable, and billing-only in a dialog, and save — producing a real `PRODUCT_OFFERING_CREATED` audit row and a new `DRAFT` offering that appears in the family-grouped table immediately, with no page navigation and no `isBundle` control anywhere in the form.

## 2. Design

**Why this unit is UI + Server Action merged, not split:** per `pm99-build-plan-phase2.md`'s own merge rule, an `actions/product/create-offering.action.ts` with no caller and a dialog with no working action behind it are each individually unverifiable as "done" — only together do they produce this unit's one demoable result (click a button, see the database and the table change).

### 2.1 Why a dialog, not a page

`Customer` module's closest precedent (`/customers/manage/new`) is a full sub-route page reached via `<Link>`. This unit does **not** follow that precedent — `pm18-spec` §2.4 already resolved this explicitly: the "New offering" CTA lives inside `ManageOfferingTable` and its seam comment says "opens `CreateOfferingDialog`," a table-level modal interaction, not a navigation to a sub-route. The much closer precedent is `components/roles/create-role-dialog.tsx` + `role-form.tsx` (Administration → Roles), which this unit mirrors near-verbatim: a controlled `Dialog`, a `react-hook-form` + `zodResolver` form living in its own file so a later unit (pm20) can extend it, and a `DialogFooter` with a `form="…"` attribute wiring the footer's submit button to the form element without nesting it inside the dialog's layout.

### 2.2 Form fields, defaults, and the permanent absence of `is_bundle`

Two fields beyond `name`: **Sellable** (checkbox, defaults **checked**) and **Billing only** (checkbox, defaults **unchecked**) — matching the mockup's create-modal defaults exactly (`<input type="checkbox" checked> Sellable`, `<input type="checkbox"> Billing only`). There is no third checkbox for `is_bundle`, and there never will be one on this form: `createOfferingSchema` (pm11) has no `isBundle` key at all, and `code-standards-phase2.md` §1 rule 9 states this as a permanent rule, not a this-unit convenience — "Neither `create-offering.schema.ts` nor `update-offering.schema.ts` includes an `isBundle` field." `OfferingForm` must never grow one, in this unit or pm20.

Both checkboxes use the `Controller` + `Checkbox`/`onCheckedChange` pattern `components/users/user-form.tsx` already established (`register()` doesn't fit `Checkbox`'s custom `onCheckedChange` callback shape) — not a new pattern.

### 2.3 Result handling — no `NAME_CONFLICT` branch

Unlike `createRoleAction`, this unit's action has exactly three failure codes: `VALIDATION_ERROR`, `FORBIDDEN`, `SERVER_ERROR`. There is no `NAME_CONFLICT` (or any other business-rule rejection) because `pm11-spec.md`'s Design section is explicit that `createOffering` has no uniqueness pre-check and no failure variant — offering names aren't required to be unique. `CreateOfferingActionResult` is correspondingly simpler than `CreateRoleActionResult`.

### 2.4 Success path — `router.refresh()`, not `router.push()`

`CreateRoleDialog` navigates to `?roleId=<new-id>` on success because Administration → Roles has a "selected role" URL-state concept the detail panel reads. Manage Products has no equivalent — `pm18-spec` defines no selected-row/query-string concept for this page at all (§2.7: "no search box, status filter, column sort... on this page"). So on success this unit's dialog: closes itself, shows a `toast.success("Offering created")`, and calls `router.refresh()` (a plain Next.js client-router refresh, not a navigation) so `page.tsx`'s server-side `fetchAllOfferingRows`/`groupIntoFamilies` re-run and the new `DRAFT` row appears in `ManageOfferingTable`'s `families` prop on the very next render — this is what satisfies pm19's own "appears in the table immediately" contract, since the Server Action's `revalidatePath` alone invalidates the cache but does not by itself re-render an already-mounted client component's props without something triggering the refetch.

### 2.5 The guardrail assertion this unit makes obsolete — updated here, not deferred to pm24

`pm99-build-plan-phase2.md` assigns "rewrite guardrail assertion 1" to Unit pm24 (the ship gate, the very last unit). Taken literally, that would leave `tests/guardrails/product-module-boundaries.test.ts`'s `it("has no actions/product/ folder", ...)` **failing** from the moment this unit's commit lands until pm24 ships — which conflicts with the "build gates green" checklist every other unit in this build (pm10, pm11, pm18) already requires before it's considered done. Two earlier planning documents (`_change-product-crud-plan.md`, `_change-product-crud-implementation-guide.md`) hit this identical gap under their own unit numbering and resolved it by requiring the folder-creating unit and the assertion-rewrite to land in the same commit, never as two separate phases with CI red in between. **This spec follows that resolution, not pm99's literal wording:** pm19 rewrites the assertion itself, scoped to exactly the one action file this unit adds. pm20–pm23 each extend the same expected-file list as their own action file lands; pm24 does the final pass once all seven exist and formally takes over ownership of the assertion, per its own contract. See Implementation §3.6.

### 2.6 What this unit explicitly does NOT do

- No edit mode, no `OfferingFormEditProps`, no "Save as new" — `offering-form.tsx` ships with only a `create` variant in this unit (pm20 extends the same file into a `RoleForm`/`UserForm`-style mode union; it is not pre-built here).
- No specification or price fields on this dialog — a brand-new offering has neither yet (pm21/pm22, reached from the new row's own actions afterward).
- No change to `app/(app)/products/manage-products/page.tsx` itself — the page's own data-fetching is untouched; only `ManageOfferingTable`'s CTA button gains real behavior.
- No new audit event type — `PRODUCT_OFFERING_CREATED` already exists (pm11); this unit's Server Action only calls the existing service, it never writes to the audit log directly.

## 3. Implementation

### 3.1 Validation — unchanged, reused as-is

`validation/product/create-offering.schema.ts` (pm11) is imported by both the new form and the new action. No edits to this file.

### 3.2 Server Action — `actions/product/create-offering.action.ts` (new)

First file in a brand-new `actions/product/` directory.

```ts
"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { createOffering } from "@/services/product/create-offering";
import { createOfferingSchema } from "@/validation/product/create-offering.schema";

export type CreateOfferingActionResult =
  | { ok: true; offeringId: string }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm19-spec §3.2. Mirrors createRoleAction's guard → safeParse → delegate →
// revalidatePath shape (architecture-phase2 §1), simplified: pm11's
// createOffering has no NAME_CONFLICT-style failure branch, so there is no
// `if (!result.ok)` fork here at all — it always succeeds once past
// validation, or throws (caught below).
export async function createOfferingAction(
  rawInput: unknown,
): Promise<CreateOfferingActionResult> {
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

  const parsed = createOfferingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result: { ok: true; offeringId: string };
  try {
    result = await createOffering(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  // Both product pages, per pm99's literal contract for this unit
  // ("revalidatePath both product pages") — Manage Products shows the new
  // row directly; View Product's own list/detail queries are also
  // invalidated even though a fresh DRAFT won't appear there under its
  // default filter until activated.
  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return { ok: true, offeringId: result.offeringId };
}
```

### 3.3 Form — `components/products/manage/offering-form.tsx` (new)

```tsx
"use client";

import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Checkbox } from "@/components/ui/checkbox";
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

type OfferingFormCreateProps = {
  mode: "create";
  onSubmit: (values: CreateOfferingInput) => Promise<void>;
  isSubmitting: boolean;
};

// pm20 (Edit offering) adds an `OfferingFormEditProps` variant and unions it
// here, mirroring RoleForm/UserForm's own two-mode shape — not built in this
// unit, since pm99's contract for pm19 is explicitly "create mode only."
export type OfferingFormProps = OfferingFormCreateProps;

export function OfferingForm(props: OfferingFormProps): React.JSX.Element {
  return <CreateOfferingForm {...props} />;
}

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
    // Matches the mockup's create-modal defaults exactly: Sellable checked,
    // Billing only unchecked (pm19-spec §2.2).
    defaultValues: { name: "", isSellable: true, billingOnly: false },
  });

  return (
    <form
      id="offering-form-create"
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            type="text"
            autoComplete="off"
            autoFocus
            placeholder="Offering name"
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
    </form>
  );
}
```

### 3.4 Dialog — `components/products/manage/create-offering-dialog.tsx` (new)

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createOfferingAction } from "@/actions/product/create-offering.action";
import { OfferingForm } from "@/components/products/manage/offering-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { CreateOfferingInput } from "@/validation/product/create-offering.schema";

export interface CreateOfferingDialogProps {
  trigger: React.ReactNode;
}

export function CreateOfferingDialog({
  trigger,
}: CreateOfferingDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    setOpen(nextOpen);
  }

  async function handleSubmit(values: CreateOfferingInput): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await createOfferingAction(values);

      if (result.ok) {
        setOpen(false);
        toast.success("Offering created");
        // No query-string selection concept on this page (pm19-spec §2.4)
        // — a plain refresh re-fetches page.tsx's server data so the new
        // DRAFT row appears in ManageOfferingTable immediately.
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else {
        // VALIDATION_ERROR here means the client bypassed the form's own
        // zodResolver (shouldn't happen in normal use) — no field-level
        // wiring needed since the form already blocks invalid submits.
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
          <DialogTitle>New offering</DialogTitle>
        </DialogHeader>

        <OfferingForm
          mode="create"
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
          <Button
            type="submit"
            form="offering-form-create"
            disabled={isSubmitting}
          >
            {isSubmitting && <Loader2 className="animate-spin" />}
            Save offering
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### 3.5 Filling the pm18 seam — `components/products/manage/manage-offering-table.tsx` (edit)

Locate the "New offering" CTA button pm18 left inert (per `pm18-spec` §3.7 point 1, `bg-[color:var(--action-cta-bg)]`, `Plus` icon, `aria-label="New offering"`, seam comment `{/* pm19 seam: onClick opens CreateOfferingDialog */}`). Wrap it with `CreateOfferingDialog`, passing the existing button as `trigger`, and delete the seam comment — the button's classes, icon, and `aria-label` are untouched:

```tsx
// Before (pm18):
<button
  type="button"
  aria-label="New offering"
  className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--action-cta-bg)] px-3 py-2 text-body-sm font-semibold text-white"
>
  <Plus size={16} aria-hidden />
  New offering
</button>
{/* pm19 seam: onClick opens CreateOfferingDialog */}

// After (pm19):
<CreateOfferingDialog
  trigger={
    <button
      type="button"
      aria-label="New offering"
      className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--action-cta-bg)] px-3 py-2 text-body-sm font-semibold text-white"
    >
      <Plus size={16} aria-hidden />
      New offering
    </button>
  }
/>
```

Add one import: `import { CreateOfferingDialog } from "@/components/products/manage/create-offering-dialog";`. No other line in this file changes — the row-action seams (Edit/Add price/Activate/Discard/Retire) stay exactly as pm18 left them; those belong to pm20–pm23.

### 3.6 Guardrail test — `tests/guardrails/product-module-boundaries.test.ts` (edit — see Design §2.5)

Replace the existing "has no `actions/product/` folder" assertion with one that checks the exact action-file set expected at this point in the build:

```ts
// Before (pm09/pm18-era):
it("has no actions/product/ folder", () => {
  expect(fs.existsSync(path.join(REPO_ROOT, "actions", "product"))).toBe(
    false,
  );
});

// After (pm19):
// pm19-spec §2.5/§3.6. Supersedes the "folder must not exist" assertion —
// pm19 is the unit that creates it. Rewritten to check the exact action
// file set expected to exist at each point in the build, so CI never sits
// red between the unit that adds a file and the unit that's nominally
// "responsible" for the guardrail rewrite (pm99 assigns that to pm24; this
// spec instead updates it incrementally, matching how
// _change-product-crud-plan.md / _change-product-crud-implementation-guide.md
// resolved the identical gap under their own unit numbering). pm20–pm23
// each append their own action file to this array as it lands; pm24 does
// the final pass once all seven exist (matching code-standards-phase2 §7's
// full file tree) and takes over ownership of this assertion for good.
const EXPECTED_PRODUCT_ACTION_FILES = ["create-offering.action.ts"];

it("actions/product/ exists and exports exactly this build's action file set", () => {
  const actionsDir = path.join(REPO_ROOT, "actions", "product");
  expect(fs.existsSync(actionsDir)).toBe(true);

  const actual = fs
    .readdirSync(actionsDir)
    .filter((name) => name.endsWith(".action.ts"))
    .sort();

  expect(actual).toEqual([...EXPECTED_PRODUCT_ACTION_FILES].sort());
});
```

No other assertion in this file changes — `PRODUCT_WRITE_SERVICE_FILES` (a separate set, scoped to `services/product/`) already contains `"create-offering.ts"` since pm11 and needs no edit here.

### 3.7 Tests

- `tests/actions/create-offering.action.test.ts` (new) — mirrors `create-role.action.test.ts`'s structure exactly, minus the `NAME_CONFLICT` case (this action has no such branch): mocks `requirePermission`, `createOffering`, and `next/cache`'s `revalidatePath`; asserts a successful call invokes `createOffering` with the parsed input and `actorId`, returns `{ ok: true, offeringId }`, and calls `revalidatePath` with **both** `/products/manage-products` and `/products/product-offering`; asserts an empty `name` returns `VALIDATION_ERROR` with a populated `fieldErrors.name` and never calls `createOffering`; asserts a redirect from `requirePermission` (both `/login` and `/no-access` targets) returns `FORBIDDEN` without calling `createOffering`; asserts a thrown error from `createOffering` returns `SERVER_ERROR`.
- `tests/components/create-offering-dialog.test.tsx` (new) — mocks `createOfferingAction` and `next/navigation`'s `useRouter`; renders `<CreateOfferingDialog trigger={<button>New offering</button>} />`, opens it via the trigger, fills the form (name, toggles both checkboxes), submits, and asserts: the action is called with the exact form values; on a successful result the dialog closes, a success toast fires, and `router.refresh()` is called; on a `FORBIDDEN`/`SERVER_ERROR` result the dialog stays open and an error toast fires; submitting with an empty name never calls the action at all (blocked client-side by `zodResolver`) and shows the field-level error from `FieldError`.
- `tests/components/manage-offering-table.test.tsx` (**edit**, pm18-owned file) — this file's existing seam test currently asserts the "New offering" CTA has "no attached behavior that changes any observable state on click" (pm18-spec §3.9). That assertion is no longer true for the CTA specifically once this unit lands — update it to assert clicking the CTA opens `CreateOfferingDialog` (e.g., the dialog's title text "New offering" becomes visible) instead of asserting no-op behavior. Leave every row-action button's own "no attached behavior" assertion untouched — those remain real seams for pm20–pm23.
- `tests/guardrails/product-module-boundaries.test.ts` — run the full suite; confirm the rewritten assertion (§3.6) passes and no other existing assertion regresses.

### 3.8 Commit

One commit. Contents: `actions/product/create-offering.action.ts` (new — first file in a new directory), `components/products/manage/offering-form.tsx` (new), `components/products/manage/create-offering-dialog.tsx` (new), `components/products/manage/manage-offering-table.tsx` (edit — one seam filled, one import added), `tests/guardrails/product-module-boundaries.test.ts` (edit — one assertion replaced), `tests/actions/create-offering.action.test.ts` (new), `tests/components/create-offering-dialog.test.tsx` (new), `tests/components/manage-offering-table.test.tsx` (edit — one assertion updated). Explicitly **not** in this commit: any change to `services/product/`, `db/repositories/`, `validation/product/`, `db/migrations/`, or `app/(app)/products/manage-products/page.tsx`.

## 4. Dependencies

**No new npm packages.** Everything this unit needs is already installed and already used elsewhere in this codebase:
- `react-hook-form` + `@hookform/resolvers/zod` — `components/roles/role-form.tsx`, `components/users/user-form.tsx`.
- `lucide-react` — `Loader2` (submit spinner, already used by `create-role-dialog.tsx`); `Plus` is pm18's, unchanged by this unit.
- `sonner` (`toast`) — already used by `create-role-dialog.tsx`.
- `components/ui/dialog.tsx`, `components/ui/checkbox.tsx`, `components/ui/input.tsx`, `components/ui/field.tsx`, `components/ui/button.tsx` — all existing primitives, no new one added.

No Zod, Drizzle, or Postgres-driver change — this unit adds no validation schema (pm11's is reused untouched) and no DB access of any kind.

## 5. Verification checklist

**Diff hygiene**
- [ ] `git status` shows only the files listed in §3.8 — nothing under `services/`, `db/`, `validation/`, or `app/(app)/products/manage-products/page.tsx`.
- [ ] `offering-form.tsx`'s `CreateOfferingInput`/schema has no `isBundle` key anywhere, and no checkbox/input for it exists in the rendered form — grep confirms it.
- [ ] `create-offering.action.ts` contains no direct DB/repository import — it calls only `services/product/create-offering`.

**Backend/Action correctness**
- [ ] An unpermitted caller (no `products` grant, or `products:READ` only) invoking `createOfferingAction` gets `{ ok: false, code: "FORBIDDEN" }` and `createOffering` is never called.
- [ ] A `products:EDIT` caller submitting valid input gets `{ ok: true, offeringId }` matching the `PRDOFR######` format, and both `revalidatePath("/products/manage-products")` and `revalidatePath("/products/product-offering")` are called.
- [ ] An empty `name` returns `VALIDATION_ERROR` with `fieldErrors.name` populated, and `createOffering` is never called.
- [ ] A thrown error from the service returns `SERVER_ERROR`, not an unhandled exception propagating to the client.

**UI behavior — the point of the unit**
- [ ] Clicking "New offering" on `/products/manage-products` opens a dialog titled "New offering" with Name, Sellable (checked by default), and Billing only (unchecked by default) — no third checkbox, no `is_bundle` control anywhere.
- [ ] Submitting with a valid name creates a real `DRAFT` row: after the dialog closes, the new offering appears in the table without a manual page reload (confirms `router.refresh()` is wired correctly), sorted alphabetically alongside existing families (per pm18's `groupIntoFamilies` sort).
- [ ] The new row shows `DRAFT`'s action set (Edit, Add price, Activate, Discard) per pm18's own status matrix — no code change needed here, just confirms pm18's matrix renders correctly for a freshly created row.
- [ ] Submitting with an empty name shows a field-level error under the Name input and never calls the Server Action (network tab / mocked-call assertion confirms this, not just visual inspection).
- [ ] Cancel closes the dialog with no request sent and no row created.
- [ ] The dialog cannot be dismissed (via Cancel, overlay click, or Escape) while a submission is in flight (`isSubmitting` gates `handleOpenChange`).
- [ ] A real `PRODUCT_OFFERING_CREATED` audit row is written for the newly created offering, with `after_data` containing the submitted `name`/`isSellable`/`billingOnly` — confirms pm11's service is genuinely being invoked end-to-end, not just its type signature.

**Guardrail suite**
- [ ] `tests/guardrails/product-module-boundaries.test.ts`'s rewritten assertion (§3.6) passes: `actions/product/` exists and contains exactly `create-offering.action.ts`.
- [ ] Every other guardrail assertion in that file still passes unmodified (price-repository shape, no-audit-import-on-reads, no `app/api/product*`).
- [ ] `tests/components/manage-offering-table.test.tsx`'s updated CTA assertion (§3.7) passes; its row-action "no behavior yet" assertions for Edit/Add price/Activate/Discard/Retire still pass unmodified.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm run test` green — full suite, including the three new/edited test files above.
- [ ] `npm run build` passes.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy) gets a pm19 entry with the commit reference, and explicitly records that the guardrail assertion for `actions/product/` was updated here (not deferred to pm24) so pm20–pm23 know to extend `EXPECTED_PRODUCT_ACTION_FILES` themselves rather than assuming it's still pm24's job alone.

**Pipeline**
- [ ] CI green end-to-end. This unit is the first to add a real mutation surface to the product module — confirm the SAST/DAST baseline shows no new finding beyond what's expected for a standard Server-Action-backed create form (matching the pattern already established by `actions/roles/create-role.action.ts`).

Any failing item means the unit is not done. Units pm20–pm23 each follow this same dialog/form/action/guardrail-increment shape — do not start any of them assuming a different pattern than what this unit establishes.
