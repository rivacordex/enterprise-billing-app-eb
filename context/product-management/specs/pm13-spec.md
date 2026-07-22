# PM13 — Backend: Update offering

- **Unit:** 13 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm11 (`insertOffering` shipped — establishes the `is_bundle`-never-user-set, two-layer-defense convention this unit continues); Unit pm12 (`branchOfferingAsDraft` shipped and verified — this unit's ACTIVE-target and `saveAsNew` paths both call it directly).
- **Authorizing sections:** `prodmgmt-architecture-phase2.md` §3 (Storage Model — `version` untouched by an in-place `DRAFT` edit, per-row sequence semantics), §6 Inv. 14 (editing an `ACTIVE` offering never mutates it in place — this unit is the first to actually trigger that clone path from a user-facing edit); `prodmgmt-code-standards-phase2.md` §1 rule 9 (`is_bundle` never user-editable, "neither `create-offering.schema.ts` nor `update-offering.schema.ts` includes an `isBundle` field"), rule 10 ("there is no service function that `UPDATE`s an `ACTIVE` `product_offering` row's content columns"); `prodmgmt-project-overview-phase2.md` Features → Offering management ("a `DRAFT` can be saved in place or explicitly 'saved as new'... an `ACTIVE` offering has no in-place option at all"); `pm99-build-plan-phase2.md` Unit pm13 (this unit's literal contract); `pm11-spec.md` / `pm12-spec.md` (the two-layer `isBundle` defense, insert-plus-audit transaction pairing, and "repositories never audit" conventions this unit continues); `services/roles/roles-write.service.ts`'s `updateRole` (the codebase's existing no-op-guard precedent — before-snapshot read ahead of the transaction, short-circuit with no write and no audit when nothing changed).
- **Codebase state assumed at start (re-verify before implementing):** Units pm10 and pm11 are confirmed shipped as of this writing — `db/repositories/product-offering.ts` exports `findList`, `findDetailById`, and `insertOffering`; `types/audit.ts`'s `AUDIT_EVENT_TYPES` ends at `"PRODUCT_OFFERING_CREATED"`; `services/product/create-offering.ts` and `validation/product/create-offering.schema.ts` exist exactly as pm11-spec.md describes. **Unit pm12 is not yet shipped as of this writing** — `branchOfferingAsDraft` does not currently exist anywhere in `db/repositories/product-offering.ts`. Do not begin this unit until every item in pm12-spec.md §5 passes; this spec is written assuming that state (branchOfferingAsDraft`, its `BranchOfferingOverrides` type, and its private `resolveNextVersion` helper all present in `db/repositories/product-offering.ts`) is true by the time implementation starts. No `updateOfferingDraftInPlace`, `activateOffering`, or `findActiveInFamily` exist yet. `services/product/update-offering.ts` and `validation/product/update-offering.schema.ts` do not exist yet.

---

## 1. Goal

Let a `products:EDIT` caller edit an offering's `name`/`isSellable`/`billingOnly`: an edit against an `ACTIVE` offering always clones it into a new sibling `DRAFT` first (never mutates the live row), an edit against a `DRAFT` updates that same row in place unless the caller sets `saveAsNew` (which clones instead), and a same-value save against a `DRAFT` writes nothing and audits nothing.

## 2. Design

**Where `offeringId` lives — a function parameter, not a schema field.** The build plan's field list for `update-offering.schema.ts` is explicit: `name`, `isSellable`, `billingOnly`, `saveAsNew` — no id. This mirrors `branchOfferingAsDraft(tx, sourceOfferingId, overrides?)`'s own shape (pm12): the id identifying *which row* is being acted on travels as its own parameter, separate from the bag of field values being applied. `updateOffering(offeringId, input, actorId)` follows the same shape. The Server Action that will call this (pm20) always knows the target id from the selected row, the same way `RoleDetail` already knows `roleId` before `editRoleFieldsSchema`'s fields are ever filled in — this unit just doesn't carry that id through Zod parsing at all, rather than parsing it and discarding it.

**Why `isBundle` isn't in the schema, continued from pm11/pm12.** Same two-layer defense: `update-offering.schema.ts` never defines an `isBundle` key, and neither `updateOfferingDraftInPlace`'s nor `branchOfferingAsDraft`'s data/override types have one either. There is no third path into this unit that could reintroduce it.

**Why `saveAsNew` never reaches `updateOfferingDraftInPlace`'s `data` parameter.** pm12-spec.md said it directly: "pm13's `updateOfferingDraftInPlace` input shares this same field set [as `BranchOfferingOverrides`] minus `saveAsNew`, which is a service-level routing flag, not an offering column." `saveAsNew` only ever gets read once, by `updateOffering` itself, to pick a branch of its own `if`/`else` — it is never threaded into any repository call's `data` argument.

**The four-way routing table this unit implements** (the build plan's prose covers three cases explicitly and is silent on the fourth; this spec makes all four concrete):

| Current status | `saveAsNew` | Action | Audit event | Target row for the audit |
|---|---|---|---|---|
| `ACTIVE` | *(ignored)* | `branchOfferingAsDraft(tx, offeringId, edit)` | `PRODUCT_OFFERING_BRANCHED` | the new sibling draft |
| `DRAFT` | `false` (or omitted-but-required-false) | `updateOfferingDraftInPlace(tx, offeringId, edit)` — **only if the edit differs from current values** | `PRODUCT_OFFERING_UPDATED` (skipped entirely on a no-op) | `offeringId` itself |
| `DRAFT` | `true` | `branchOfferingAsDraft(tx, offeringId, edit)` | `PRODUCT_OFFERING_BRANCHED` | the new sibling draft |
| `RETIRED` | *(irrelevant)* | rejected before any write | — (no audit) | — |

The `RETIRED` row is this spec's own addition, not literal build-plan text. `RETIRED` is terminal (project-overview-phase2 "Any transition out of `RETIRED`" is out of scope) and `pm18`'s row-action matrix never renders an Edit affordance on a `RETIRED` row, so this path isn't reachable from the shipped UI. It's guarded here anyway, defensively, the same way `updateRole` checks `ROLE_NOT_FOUND` before doing anything else rather than trusting the caller — a stray direct call (a test, a future caller, a bug in pm20) should get a typed rejection, not a silent no-op or an accidental in-place mutation of a row this module's own invariants say must never be edited in place again.

**Why the no-op guard applies only to the plain `DRAFT`-in-place row, not to either branch path.** The build plan's no-op sentence sits immediately after describing the plain in-place case, and reading it that narrowly is also the only reading consistent with the rest of the phase's own stated rules: the project overview says an edit against `ACTIVE` "always" produces a new draft, and `saveAsNew`'s entire purpose is to force a sibling regardless of whether the values actually changed (pm20's UI literally offers it as an alternative to "Save," not as a smarter version of it). Both branch paths are version-creation actions, not field-persistence actions — "nothing changed" isn't a meaningful skip condition for either of them. Only the plain in-place path is answering the question "did this write need to happen at all," which is exactly `updateRole`'s own no-op guard's job.

**Result shape carries `branched` and the possibly-new id.** `saveAsNew` and an `ACTIVE`-target edit both hand the caller back a *different* offering id than the one they started with — the UI (pm20) needs to know this to redirect/refresh to the right row instead of re-rendering the original (now-untouched) one.

```ts
export type UpdateOfferingResult =
  | { ok: true; offeringId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" };
```

`offeringId` is the id to act on next: the same id passed in when `branched` is `false` (including the no-op case), the new sibling's id when `branched` is `true`.

**Audit `targetId` for a `PRODUCT_OFFERING_BRANCHED` event points at the new row, not the source** — mirroring `createOffering`'s own precedent of targeting the row that now exists. `beforeData`/`afterData` both carry an explicit `sourceOfferingId` field (not implied by `family_offering_id` alone) so a reviewer reading the audit log can see which row this branch came from without cross-referencing the schema.

**Why the branch-and-audit block is factored into one private helper, reused by both branch-triggering paths.** The `ACTIVE`-target case and the `saveAsNew`-on-`DRAFT` case call `branchOfferingAsDraft` with the same `edit` shape and write the exact same `PRODUCT_OFFERING_BRANCHED` audit shape from the exact same `db.transaction` pattern — only *why* they got there differs. A private `branchAndAudit(offeringId, current, edit, actorId)` helper (not exported) avoids duplicating that transaction block twice in one file.

**Why `updateOfferingDraftInPlace`'s own `WHERE lifecycle_status = 'DRAFT'` clause is a backstop, not the primary check.** The service already reads the offering's current status (via the existing `findDetailById`) and only ever calls this method from the branch of its own `if` that already knows the row is `DRAFT`. The repository-level `WHERE` clause closes the window against a future implementer calling this method directly without that surrounding check — mirroring the "throw on an unexpected zero-row result" discipline `insertOffering` and `branchOfferingAsDraft` already use for their own `if (!row)` guards, not the transactional re-check pattern Inv. 13's `activateOffering` will need (this isn't a concurrency-critical single-slot invariant; it's "don't silently no-op a caller mistake").

**No new repository read method.** The service reuses pm03's existing `findDetailById(db, offeringId)` for both the before-snapshot (no-op comparison, audit `beforeData`) and the status check that drives routing — it already returns `name`, `isSellable`, `billingOnly`, and `lifecycleStatus` in one shape.

**No visual/UI design in this unit** — backend service/data-access layer only, per the build plan's boundary. `actions/product/update-offering.action.ts` and `offering-form.tsx`'s edit mode belong to pm20.

## 3. Implementation

### 3.1 Validation — `validation/product/update-offering.schema.ts` (new)

```ts
import { z } from "zod";

export const updateOfferingSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Offering name is required")
    .max(200, "Offering name must be 200 characters or fewer"),
  isSellable: z.boolean(),
  billingOnly: z.boolean(),
  saveAsNew: z.boolean(),
});

export type UpdateOfferingInput = z.infer<typeof updateOfferingSchema>;
```

Same `.trim().min().max()` convention and `200`-character ceiling as `create-offering.schema.ts` (pm11-spec §3.1) — the two schemas should stay visibly parallel since they validate the same three offering fields. `saveAsNew` is required, not `.default(false)`: pm20's form always renders an explicit save-mode choice, so there is no ambiguous "caller forgot to say" case to paper over. No `offeringId` key — see Design.

### 3.2 Repository — `db/repositories/product-offering.ts` (edit — add `updateOfferingDraftInPlace`)

No new imports needed — `and` and `eq` are already imported by this file (v1 baseline), and pm12 will already have added `productOfferingPrice`/`productSpecifications`/`or`/`sql` for `branchOfferingAsDraft`, none of which this method needs.

Add to the existing `productOfferingRepository` object (alongside `findList` / `findDetailById` / pm11's `insertOffering` / pm12's `branchOfferingAsDraft`):

```ts
// pm13-spec §3.2. Valid only when the target row is currently DRAFT — the
// WHERE clause below is a defense-in-depth backstop (Design), not the
// primary check; the calling service already branches on status before
// ever reaching this method. Does not touch `version` (architecture-phase2
// §3: version is assigned once at insert and never changed afterward).
async updateOfferingDraftInPlace(
  tx: Database,
  draftId: string,
  data: {
    name: string;
    isSellable: boolean;
    billingOnly: boolean;
    lastEditedBy: string;
  },
): Promise<{ offeringId: string }> {
  const [row] = await tx
    .update(productOffering)
    .set({
      name: data.name,
      isSellable: data.isSellable,
      billingOnly: data.billingOnly,
      lastEditedBy: data.lastEditedBy,
      lastModified: new Date(),
    })
    .where(
      and(
        eq(productOffering.productOfferingId, draftId),
        eq(productOffering.lifecycleStatus, "DRAFT"),
      ),
    )
    .returning({ offeringId: productOffering.productOfferingId });
  if (!row) {
    throw new Error(
      `updateOfferingDraftInPlace: offering ${draftId} not found or not DRAFT`,
    );
  }
  return { offeringId: row.offeringId };
},
```

Mirrors `organizationRepository.update`'s shape (`db/repositories/organization.ts`) — `data` carries the editor id in-band (`lastEditedBy`, not a separate parameter) and the method stamps the timestamp column itself via `.set({ ..., lastModified: new Date() })` — the closest existing precedent in this codebase for "edit an entity in place and stamp who/when." `isBundle`, `familyOfferingId`, and `version` are absent from `.set()` entirely, not just left at their existing values by coincidence — there is no code path here that could touch them.

### 3.3 Audit event types — `types/audit.ts` (edit — append two entries)

```ts
export const AUDIT_EVENT_TYPES = [
  // ...existing entries, unchanged, through "PRODUCT_OFFERING_CREATED"...
  "PRODUCT_OFFERING_CREATED",
  "PRODUCT_OFFERING_UPDATED",
  "PRODUCT_OFFERING_BRANCHED",
] as const;
```

Append only, in this order (matching the build plan's own listing order for pm13's two events) — do not reorder or touch any existing entry. Later units append their own: `PRODUCT_OFFERING_ACTIVATED`/`_SUPERSEDED`/`_RETIRED`/`_DISCARDED` (pm16), `PRODUCT_SPECIFICATION_*` (pm14), `PRODUCT_PRICE_ADDED` (pm15).

### 3.4 Service — `services/product/update-offering.ts` (new)

```ts
import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { UpdateOfferingInput } from "@/validation/product/update-offering.schema";

export type UpdateOfferingResult =
  | { ok: true; offeringId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" };

type OfferingEdit = {
  name: string;
  isSellable: boolean;
  billingOnly: boolean;
};

// pm13-spec §3.4. Clones into a new sibling DRAFT and writes
// PRODUCT_OFFERING_BRANCHED — shared by the ACTIVE-target path and the
// saveAsNew-on-DRAFT path (Design), which differ only in *why* they got
// here, not in what they do once they have.
async function branchAndAudit(
  offeringId: string,
  current: { name: string; isSellable: boolean; billingOnly: boolean },
  edit: OfferingEdit,
  actorId: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const { offeringId: branchedId } =
      await productOfferingRepository.branchOfferingAsDraft(
        tx,
        offeringId,
        edit,
      );

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_BRANCHED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: branchedId,
      beforeData: { sourceOfferingId: offeringId, ...current },
      afterData: { sourceOfferingId: offeringId, ...edit },
    });

    return branchedId;
  });
}

export async function updateOffering(
  offeringId: string,
  input: UpdateOfferingInput,
  actorId: string,
): Promise<UpdateOfferingResult> {
  const current = await productOfferingRepository.findDetailById(
    db,
    offeringId,
  );
  if (!current) {
    return { ok: false, code: "OFFERING_NOT_FOUND" };
  }
  if (current.lifecycleStatus === "RETIRED") {
    return { ok: false, code: "OFFERING_RETIRED" };
  }

  const edit: OfferingEdit = {
    name: input.name,
    isSellable: input.isSellable,
    billingOnly: input.billingOnly,
  };
  const before: OfferingEdit = {
    name: current.name,
    isSellable: current.isSellable,
    billingOnly: current.billingOnly,
  };

  if (current.lifecycleStatus === "ACTIVE") {
    const branchedId = await branchAndAudit(
      offeringId,
      before,
      edit,
      actorId,
    );
    return { ok: true, offeringId: branchedId, branched: true };
  }

  // current.lifecycleStatus === "DRAFT" from here on.
  if (input.saveAsNew) {
    const branchedId = await branchAndAudit(
      offeringId,
      before,
      edit,
      actorId,
    );
    return { ok: true, offeringId: branchedId, branched: true };
  }

  const unchanged =
    before.name === edit.name &&
    before.isSellable === edit.isSellable &&
    before.billingOnly === edit.billingOnly;
  if (unchanged) {
    return { ok: true, offeringId, branched: false };
  }

  await db.transaction(async (tx) => {
    await productOfferingRepository.updateOfferingDraftInPlace(tx, offeringId, {
      ...edit,
      lastEditedBy: actorId,
    });

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_UPDATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: offeringId,
      beforeData: before,
      afterData: edit,
    });
  });

  return { ok: true, offeringId, branched: false };
}
```

`before`/`edit` share the exact same three-key shape deliberately — the no-op comparison is three plain `===` checks, no deep-equal utility needed. `targetEntity: "PRODUCT_OFFERING"` matches `createOffering`'s convention (pm11-spec §3.4).

### 3.5 No Server Action, no UI, no schema-diff, no new audit event beyond the two above, in this unit

Per the build plan's boundary line and dependency graph, `actions/product/update-offering.action.ts` and `offering-form.tsx`'s edit mode belong to pm20. `db/schema/product.ts` is untouched — this unit writes existing columns only. Do not add either even though it would be easy to keep going — the guardrail test's "no `actions/product/` folder" assertion (currently in `tests/guardrails/product-module-boundaries.test.ts`, to be rewritten in pm24) still expects it absent until pm19.

## 4. Dependencies

**No new npm packages.** Zod, Drizzle, and the Postgres driver are already installed and already used by every existing validation schema, repository, and write service in this codebase. **No DB extensions, no migration.**

## 5. Verify when done

**Diff hygiene**
- [ ] `git status` shows only: `validation/product/update-offering.schema.ts` (new), `db/repositories/product-offering.ts` (one new method added; `findList`/`findDetailById`/`insertOffering`/`branchOfferingAsDraft` untouched), `types/audit.ts` (exactly two new array entries, appended last), `services/product/update-offering.ts` (new). No `actions/`, `components/`, `app/`, or `db/schema/` changes.
- [ ] `updateOfferingDraftInPlace`'s `data` parameter type has no `isBundle` key, and `updateOffering`'s `edit`/`before` objects never read or write `isBundle` — grep confirms no code path in this diff touches `isBundle`/`is_bundle`.

**Backend correctness — in-place `DRAFT` edit**
- [ ] Calling `updateOffering(draftId, { name: "New Name", isSellable: false, billingOnly: true, saveAsNew: false }, actorId)` against a seeded `DRAFT` row updates that same row's `name`/`is_sellable`/`billing_only`, bumps `last_modified` to a later timestamp, sets `last_edited_by` to `actorId`, and leaves `version` and `family_offering_id` exactly as they were.
- [ ] Exactly one audit row appears with `event_type = 'PRODUCT_OFFERING_UPDATED'`, `target_id` equal to the draft's own id, `before_data` matching the pre-edit values, `after_data` matching the submitted values.
- [ ] The result is `{ ok: true, offeringId: draftId, branched: false }`.

**Backend correctness — no-op guard**
- [ ] Calling `updateOffering` against a `DRAFT` with `name`/`isSellable`/`billingOnly` identical to its current values (`saveAsNew: false`) returns `{ ok: true, offeringId: draftId, branched: false }`, performs zero `UPDATE` statements against `product_offering`, and writes zero new audit rows.
- [ ] `last_modified` on the row is unchanged (re-fetch and compare) after a no-op call.

**Backend correctness — `ACTIVE`-target edit (branch, never mutate)**
- [ ] Calling `updateOffering` against an `ACTIVE` offering (e.g. the seed's "5G Nationwide Service Plan," per pm12-spec's own fixture) with `saveAsNew: false` (irrelevant/ignored on this path) leaves that row and every column on it byte-identical afterward (re-fetch and compare against a pre-call snapshot), and leaves its specification and price rows byte-identical and still pointing at the original id.
- [ ] The call produces exactly one new row: `lifecycle_status = 'DRAFT'`, `family_offering_id` resolved one hop to the source's family root, `version` = family max + 1, `name`/`is_sellable`/`billing_only` equal to the submitted edit, `is_bundle` equal to the source's own `is_bundle`.
- [ ] Exactly one audit row appears with `event_type = 'PRODUCT_OFFERING_BRANCHED'`, `target_id` equal to the *new* row's id (not the source's), `before_data.sourceOfferingId` and `after_data.sourceOfferingId` both equal to the source's id.
- [ ] The result is `{ ok: true, offeringId: <newId>, branched: true }` where `<newId>` differs from the source id.
- [ ] Calling with a submitted edit identical to the source's current values against an `ACTIVE` target *still* branches (no no-op short-circuit on this path) — confirms the no-op guard's scoping (Design).

**Backend correctness — `saveAsNew` on a `DRAFT`**
- [ ] Calling `updateOffering` against a `DRAFT` with `saveAsNew: true` leaves that original draft row and its children byte-identical afterward, and produces exactly one new sibling `DRAFT` in the same family (same `family_offering_id` resolution and `version` rules as the `ACTIVE`-target case above) carrying the edit.
- [ ] Calling with `saveAsNew: true` and an edit identical to the draft's current values *still* branches (no no-op short-circuit) — same scoping proof as the `ACTIVE` case, on the other trigger.
- [ ] The audit row's `event_type` is `PRODUCT_OFFERING_BRANCHED`, identical shape to the `ACTIVE`-target case's audit row.

**Backend correctness — not-found and terminal-status guards**
- [ ] Calling `updateOffering` with a nonexistent `offeringId` returns `{ ok: false, code: "OFFERING_NOT_FOUND" }` and writes nothing.
- [ ] Calling `updateOffering` against a `RETIRED` offering returns `{ ok: false, code: "OFFERING_RETIRED" }`, calls neither `updateOfferingDraftInPlace` nor `branchOfferingAsDraft`, and writes no audit row.

**Boundary**
- [ ] `services/product/update-offering.ts` and `validation/product/update-offering.schema.ts` contain no `next/*` import, no `"use server"` directive.
- [ ] `db/repositories/product-offering.ts` still contains no import of `@/db/repositories/audit.repository`, no reference to `insertAuditEvent` or `AUDIT_LOG` — `tests/guardrails/product-module-boundaries.test.ts`'s existing "no product read path imports the audit-log write path" check continues to pass unmodified.
- [ ] No `actions/product/` directory or file exists yet after this unit (that's pm19/pm20).

**Build gates**
- [ ] `npm run typecheck` green — `UpdateOfferingInput`, `UpdateOfferingResult`, `updateOfferingDraftInPlace`'s parameter/return types all resolve with no manual `any`.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] Existing Phase 1, pm11, and pm12 tests still pass unmodified — this unit adds one repository method, two audit-type entries, and one new service file; it touches no existing method's behavior or signature.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy, not the plan-folder mirror) gets a pm13 entry with the commit reference, once this actually ships.

Any failing item means the unit is not done. Units pm14 (specifications) and pm15 (prices) do not depend on this unit directly (both depend on pm12 only), but pm20 (Edit offering UI) depends on `updateOffering`'s exact result shape — including the `branched`/`offeringId` fields — existing and verified; do not start pm20 until every item above passes.
