# PM14 — Backend: Specification management

- **Unit:** 14 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm12 (`branchOfferingAsDraft` shipped and verified — every branch-first path in this unit calls it directly, with no `overrides`). Not dependent on pm13 — pm13 (update offering) and pm14 (this unit) both branch from pm12 independently per the dependency graph and may land in either order.
- **Authorizing sections:** `prodmgmt-project-overview-phase2.md` "Specification management" ("Add and edit specifications on a `DRAFT`. On an `ACTIVE` offering, adding or editing a specification triggers the clone-to-new-draft behavior... Hard delete is available for a specification, but only on a `DRAFT` row — and since specification writes against an `ACTIVE` offering always land on a freshly cloned draft first, this condition holds automatically") and Success Criteria ("Deleting a specification is only ever possible on a `DRAFT` row — confirmed both by the service logic and by a guardrail test asserting no code path calls it against an `ACTIVE` offering"); `prodmgmt-architecture-phase2.md` §6 Inv. 14 (editing an `ACTIVE` offering's specifications never mutates them in place) and the "New rules" table (`is_bundle`/branch conventions this unit does not touch); `prodmgmt-code-standards-phase2.md` §1 rule 10 ("Editing an `ACTIVE` offering never mutates it in place... its specifications, or its prices... routes through `branchOfferingAsDraft` first") and §6 rule 12 ("A price or specification write against an `ACTIVE` offering always lands on a freshly branched `DRAFT`, never on the `ACTIVE` row... this is why `deleteSpecification`'s 'only on a `DRAFT`' rule... holds by construction in Phase 2 — by the time any spec-write function is called, its target offering is guaranteed `DRAFT`"); `pm99-build-plan-phase2.md` Unit pm14 (this unit's literal contract) and its guardrail 10, "Spec-delete unreachable on `ACTIVE`"; `pm12-spec.md` (`branchOfferingAsDraft`'s exact signature, clone-content guarantees, and "repositories never audit" convention); `pm13-spec.md` (the `offeringId`-as-parameter-not-schema-field convention, the branch-vs-direct routing shape, and its `OFFERING_RETIRED` defensive guard — both continued here); `pm03-spec.md` §3.3 (the "Phase 1 finder file," `db/repositories/product-specification.ts`, and `SpecificationCard`'s shape).
- **Codebase state assumed at start (re-verify before implementing):** Units pm10 and pm11 are confirmed shipped as of this writing — `db/schema/product.ts` has `family_offering_id` + its index; `db/repositories/product-offering.ts` exports `findList`, `findDetailById`, `insertOffering`. **Unit pm12 is not yet shipped as of this writing** — `branchOfferingAsDraft` does not exist anywhere in `db/repositories/product-offering.ts`. Do not begin this unit until every item in `pm12-spec.md` §5 passes; this spec is written assuming that state is true by the time implementation starts. `db/repositories/product-specification.ts` exports only `findByOfferingId(db, productOfferingId): Promise<SpecificationCard[]>` (pm03's "Phase 1 finder file") — no write methods exist yet. `types/audit.ts`'s `AUDIT_EVENT_TYPES` ends at `"PRODUCT_OFFERING_CREATED"` as of this writing; if pm13 has landed first by the time this unit starts, it will additionally end with `"PRODUCT_OFFERING_UPDATED"`, `"PRODUCT_OFFERING_BRANCHED"` — either way, this unit only ever appends, never reorders. `tests/guardrails/product-module-boundaries.test.ts`'s `PRODUCT_WRITE_SERVICE_FILES` set currently contains only `"create-offering.ts"`; if pm13 has landed first it will also contain `"update-offering.ts"` — this unit adds its own three filenames to whatever that set already contains. No `services/product/add-specification.ts`, `update-specification.ts`, or `delete-specification.ts` exist yet. `validation/product/create-specification.schema.ts` and `update-specification.schema.ts` do not exist yet.

---

## 1. Goal

Let a `products:EDIT` caller create, edit, and hard-delete a product offering's specifications: every write against a `DRAFT` offering applies directly to that offering's own specification rows; every write against an `ACTIVE` offering transparently clones the offering (and its specifications and prices, via `branchOfferingAsDraft`) into a new sibling `DRAFT` first and applies the write to the corresponding row on that clone, leaving the `ACTIVE` row and its children byte-for-byte untouched — so that, by construction, the specification repository's delete method is never invoked against a row whose parent offering is `ACTIVE`.

## 2. Design

**Where `offeringId` and `specId` live — function parameters, not schema fields.** Continuing pm13's convention exactly: the build plan's field list for both schemas is silent on any id (only specification content fields are named), and `updateOfferingDraftInPlace`/`branchOfferingAsDraft` already establish "the id travels as its own parameter, separate from the field-value bag" as this module's shape. `updateSpecification(specId, offeringId, input, actorId)` and `deleteSpecification(specId, offeringId, actorId)` both take `offeringId` **and** `specId` as separate parameters, not just `specId` — see the next point for why `offeringId` must be supplied by the caller rather than derived.

**Why `offeringId` is a required parameter even though every specification row already carries `ref_product_offering_id`.** The service needs the offering's current `lifecycleStatus` to decide branch-first vs. direct *before* it does anything else, and the cheapest way to get that is `productOfferingRepository.findDetailById(db, offeringId)` — a method that already exists and already returns `lifecycleStatus`. Deriving `offeringId` from the spec row first would mean either extending `product-specification.ts` with a new `findById` finder (not in this unit's file list) or reading the raw table row before `productSpecificationRepository.findByOfferingId` has any use for it. Instead, this unit reuses `findByOfferingId(db, offeringId)` for *both* purposes at once — confirming the offering's status and fetching the target spec's current content in the same call (see next point) — which only works if the caller already supplies `offeringId`. This is not a new assumption: pm18's UI always reaches a specification's edit/delete affordance from *within* a specific offering row's expanded detail, so the caller always has `offeringId` in scope already, the same way pm20's `offering-form.tsx` always knows which offering row it's editing before it ever calls `updateOffering`.

**No new repository read method — `findByOfferingId` does double duty.** `updateSpecification` and `deleteSpecification` both call `productSpecificationRepository.findByOfferingId(db, offeringId)` once, ahead of the transaction, and `.find()` the target `productSpecId` in the returned list. This simultaneously (a) confirms the spec exists and genuinely belongs to the given offering — if `.find()` comes back `undefined`, that is `SPECIFICATION_NOT_FOUND`, whether because the id is wrong or because it belongs to a *different* offering — and (b) captures the spec's full current content as the audit `before_data` snapshot and (for the `ACTIVE`-target path) the byte-for-byte template the branched clone must match. Mirrors pm13's own precedent: "no new repository read method... reuses [an] existing finder... it already returns [what's needed] in one shape."

**The branch-first routing table this unit implements, per service, is uniform across create/update/delete** — the build plan's own line describes all three the same way ("branch-first... when the target offering is `ACTIVE`, direct otherwise"):

| Service | `DRAFT` target | `ACTIVE` target | `RETIRED` target |
|---|---|---|---|
| `addSpecification` | `insertSpecification(tx, offeringId, data)` directly | `branchOfferingAsDraft(tx, offeringId)` (no overrides), then `insertSpecification(tx, branchedId, data)` | rejected before any write |
| `updateSpecification` | `updateSpecification(tx, specId, data)` directly | branch, then locate the cloned counterpart of `specId` on the branch, then `updateSpecification(tx, counterpartId, data)` | rejected before any write |
| `deleteSpecification` | `deleteSpecification(tx, specId)` directly | branch, then locate the cloned counterpart of `specId` on the branch, then `deleteSpecification(tx, counterpartId)` | rejected before any write |

The `RETIRED` row is this spec's own addition, not literal build-plan text — the same disclosed addition pm13-spec made for `updateOffering`, for the same reason: `RETIRED` is terminal (project-overview-phase2, "Any transition out of `RETIRED`" is out of scope) and pm18's row-action matrix never renders a specification affordance on a `RETIRED` row, so this path isn't reachable from the shipped UI. Guarded here anyway, defensively, so a stray direct call gets a typed rejection rather than an accidental write.

**Why `deleteSpecification`'s branch-first path does *not* violate "delete is only ever possible on a `DRAFT` row."** Read literally, `pm99-build-plan-phase2.md`'s guardrail 10 is about the *repository* call: "no code path calls `deleteSpecification` against an offering whose current status is `ACTIVE`." When the target offering is `ACTIVE`, this unit's service branches first — by the time `productSpecificationRepository.deleteSpecification` is actually invoked, its target row always belongs to the freshly created `DRAFT` clone, never to the original `ACTIVE` row. The `ACTIVE` row and its own specification rows are left completely untouched (Inv. 14); "deleting a spec on an `ACTIVE` offering" *means* "produce a new sibling `DRAFT` that has every one of the source's specifications except this one" — exactly parallel to how pm13's `ACTIVE`-target edit means "produce a new sibling `DRAFT` with the edited field," never an in-place `UPDATE` on the live row. The guardrail's own repository-level phrasing ("against an offering whose current status is `ACTIVE`") is satisfied by construction: the repository method's target offering, at the instant it's called, is always `DRAFT`.

**The "locate the cloned counterpart" problem, and why it's solved by content-matching rather than by extending `branchOfferingAsDraft`.** `branchOfferingAsDraft(tx, sourceOfferingId, overrides?)`'s `overrides` parameter is offering-level only (`name?`, `isSellable?`, `billingOnly?` — pm12-spec §3.1's `BranchOfferingOverrides`) and its bulk `INSERT ... VALUES` for cloned specification rows has no `.returning()`, so it hands back no source-id-to-clone-id mapping (pm12-spec §3.1's code, read directly: the clone loop returns nothing per-row). Extending `branchOfferingAsDraft` to add either capability is out of scope for this unit — pm14's file list touches `db/repositories/product-specification.ts` only, and pm12's own "Diff hygiene" checklist item ("`git status` shows exactly one changed file... `findList`, `findDetailById`, and pm11's `insertOffering` untouched") is exactly the kind of guarantee later units are expected to preserve, not erode. Instead, `update-specification.ts` and `delete-specification.ts` each capture the target spec's full pre-branch content (`name`, `isMandatory`, `isDefault`, `defaultValue`, `productSpecCharacteristics`) via the `findByOfferingId` call already described above, call `branchOfferingAsDraft(tx, offeringId)` with no overrides, then call `productSpecificationRepository.findByOfferingId(tx, branchedId)` again against the *new* draft and pick the one row whose full content exactly matches the pre-branch snapshot. This is exact, not approximate: pm12-spec's own verification checklist guarantees "every cloned specification row's `name`, `is_mandatory`, `is_default`, `default_value`, and `product_spec_characteristics` exactly match its corresponding source row" — content-matching only works *because* `branchOfferingAsDraft` already promises byte-identical cloning; this unit leans on that promise rather than re-deriving it.

**Disclosed limitation of content-matching:** if a source offering somehow has two specifications with fully identical content across all five fields (name, mandatory flag, default flag, default value, and characteristics record — a genuine content duplicate, not just a duplicate name), content-matching cannot tell them apart and the lookup throws rather than guessing. Nothing in `db/schema/product.ts` prevents duplicate specification content today (no unique index), so this is a real, disclosed gap — not an oversight — mirroring pm12-spec's own disclosed gap around concurrent version numbering. It is also no worse than the UI's own problem: two specification rows with genuinely identical content are already indistinguishable to a human editing them, so a hard failure here (versus a wrong-row update) is the safer of two options. If this needs a real fix later, the fix belongs in `branchOfferingAsDraft` itself (returning a source-id → clone-id map via `.returning()`), not in this unit — flagging it here so it isn't rediscovered as new.

**Matching is a small private helper, not a shared exported utility, and is duplicated once between `update-specification.ts` and `delete-specification.ts`.** Same judgment call pm12-spec made for `resolveFamilyRootId`: it is a single ~15-line function used by exactly two call sites today; a shared module for two callers costs more than the duplication does. If a third caller ever needs it (there is no plan for one in this phase), that caller's unit is the right place to extract it.

**Why there is no no-op guard on the in-place `DRAFT` update path, unlike `updateOffering`'s.** `pm99-build-plan-phase2.md`'s text for this unit says nothing about skipping a no-op write, unlike pm13's unit text, which states the no-op guard explicitly ("no-op guard skips the write and audit entirely if nothing actually changed"). Reading the build plan's silence narrowly here (the same interpretive stance pm13-spec itself took toward the build plan's own silences) means `updateSpecification` always writes and always audits, even when the submitted values are identical to the current ones. This is a deliberate, disclosed scoping choice, not an omission — if a future reviewer wants the no-op guard added, it is a small, additive change to `services/product/update-specification.ts` alone.

**Audit shape: one event per action, always `PRODUCT_SPECIFICATION_CREATED`/`_UPDATED`/`_DELETED` — never an additional `PRODUCT_OFFERING_BRANCHED` alongside it.** This is different from `updateOffering`, which logs `PRODUCT_OFFERING_BRANCHED` because the offering itself is the subject of that action. Here, the specification is the subject; the branch (when it happens) is a mechanism, not the semantic content of what the actor did. `prodmgmt-project-overview-phase2.md`'s audit trail section lists "specification created, updated, deleted" as its own group, distinct from the offering event group, reinforcing that a spec action logs exactly one spec-shaped event regardless of whether a branch occurred underneath it. `targetEntity: "PRODUCT_SPECIFICATION"` (a new, free-text value — `target_entity` has no DB-level enum to extend) and `targetId` is the id of the row actually written: the branched clone's new spec id when a branch happened, the original spec id otherwise — mirroring pm13's own rule that a `PRODUCT_OFFERING_BRANCHED` audit row's `targetId` points at the new row, not the source. When a branch did happen, `afterData` (and, for delete, `beforeData`) additionally carries `branchedFromOfferingId` so a reviewer can trace the lineage without cross-referencing `family_offering_id` by hand — the same transparency reason pm13's branch audit payload carries an explicit `sourceOfferingId`.

**Result shape carries `offeringId` and `branched`, mirroring `UpdateOfferingResult`.** The caller (pm21's UI, later) needs to know whether the write landed on the same offering row it started with or a new sibling draft, exactly as pm20 needs this from `updateOffering`.

```ts
export type AddSpecificationResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" };

export type UpdateSpecificationResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "SPECIFICATION_NOT_FOUND" };

export type DeleteSpecificationResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "SPECIFICATION_NOT_FOUND" };
```

`productSpecId` in every `ok: true` result is the id of the row the action actually acted on — the branched clone's fresh id when `branched: true`, the original id otherwise. For `deleteSpecification`, this is the id that *no longer exists* after the call returns — useful for the UI to know which row to remove from its own state without a refetch.

**Repository methods take no status/id-matching backstop, unlike `updateOfferingDraftInPlace`'s defensive `WHERE lifecycle_status = 'DRAFT'` clause.** The build plan is explicit that these three methods have "unchanged signatures from the Phase 1 finder file" and that "callers guarantee the target row is always `DRAFT`" — meaning the guarantee is the *service's* job (via branch-first routing), not the repository's. This is also structurally necessary, not just a style choice: `product_specifications` carries no `lifecycle_status` column of its own (status lives only on the parent `product_offering`), so any backstop here would require a join the build plan does not ask for and the "Phase 1 finder file" precedent does not establish.

**No visual/UI design in this unit** — backend service/data-access layer only, per the build plan's boundary. `actions/product/create-specification.action.ts`, `update-specification.action.ts`, `delete-specification.action.ts`, and `specification-form.tsx` all belong to pm21.

## 3. Implementation

### 3.1 Validation — `validation/product/create-specification.schema.ts` (new)

```ts
import { z } from "zod";

import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";

export const createSpecificationSchema = z.object({
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
    .max(500, "Default value must be 500 characters or fewer")
    .nullable()
    .default(null),
  productSpecCharacteristics: productSpecCharacteristicsSchema,
});

export type CreateSpecificationInput = z.infer<typeof createSpecificationSchema>;
```

Same `.trim().min().max()` convention as `create-offering.schema.ts`; `200`-character ceiling on `name` matches the offering-name ceiling so the two schemas stay visibly parallel (no existing precedent constrains specification `name` length specifically — this unit picks 200 for consistency, not because the DB enforces it; `name` is plain `text`). `defaultValue`'s `.nullable().default(null)` follows `contact-medium.schema.ts`/`organization.schema.ts`'s established convention for optional text fields, not `create-offering.schema.ts`'s (which has no nullable fields). `productSpecCharacteristics` reuses the existing `productSpecCharacteristicsSchema` (`z.record(z.string().min(1), z.string())`) unchanged — no new characteristics validation in this unit. No cross-field refinement between `isDefault` and `defaultValue` (e.g. requiring a non-null `defaultValue` when `isDefault` is `true`) — nothing in `db/schema/product.ts` (no CHECK constraint) or any authorizing doc establishes that rule, so this unit does not invent one.

### 3.2 Validation — `validation/product/update-specification.schema.ts` (new)

```ts
import { z } from "zod";

import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";

export const updateSpecificationSchema = z.object({
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
    .max(500, "Default value must be 500 characters or fewer")
    .nullable()
    .default(null),
  productSpecCharacteristics: productSpecCharacteristicsSchema,
});

export type UpdateSpecificationInput = z.infer<typeof updateSpecificationSchema>;
```

Field-identical to `createSpecificationSchema` — a full-replacement edit (all editable fields resubmitted), the same shape `update-offering.schema.ts` uses relative to `create-offering.schema.ts` (minus `saveAsNew`, which has no specification equivalent — there is no "save spec as new" concept). No `productSpecId` key, for the same reason `update-offering.schema.ts` has no `offeringId` key (Design, §2). No delete schema in this unit — the build plan names only these two schema files; `deleteSpecification`'s Server Action (pm21) will validate its id(s) directly, the same way `delete-role.schema.ts` validates a bare `{ roleId }` with no other fields.

### 3.3 Repository — `db/repositories/product-specification.ts` (edit — add three write methods)

```ts
import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { productSpecifications } from "@/db/schema/product";
import type { ProductSpecCharacteristics } from "@/validation/product/product-spec-characteristics.schema";
import type { SpecificationCard } from "@/types/product";

export const productSpecificationRepository = {
  async findByOfferingId(
    db: Database,
    productOfferingId: string,
  ): Promise<SpecificationCard[]> {
    // ...unchanged from pm03 (Phase 1 finder file) — see current file.
  },

  // pm14-spec §3.3. `refProductOfferingId` is supplied by the caller — the
  // service already knows whether that's the original DRAFT offering or a
  // freshly branched clone (Design). No status backstop here: this table
  // has no lifecycle_status column of its own, and "target is always DRAFT"
  // is a caller guarantee, not a repository-enforced one (build plan's own
  // wording, §pm14 header).
  async insertSpecification(
    tx: Database,
    data: {
      refProductOfferingId: string;
      name: string;
      isMandatory: boolean;
      isDefault: boolean;
      defaultValue: string | null;
      productSpecCharacteristics: ProductSpecCharacteristics;
    },
  ): Promise<{ productSpecId: string }> {
    const [row] = await tx
      .insert(productSpecifications)
      .values({
        refProductOfferingId: data.refProductOfferingId,
        name: data.name,
        isMandatory: data.isMandatory,
        isDefault: data.isDefault,
        defaultValue: data.defaultValue,
        productSpecCharacteristics: data.productSpecCharacteristics,
      })
      .returning({ productSpecId: productSpecifications.productSpecId });
    if (!row) {
      throw new Error("insertSpecification: insert returned no row");
    }
    return { productSpecId: row.productSpecId };
  },

  // pm14-spec §3.3. `productSpecId` is guaranteed by the caller to belong
  // to a DRAFT offering (Design) — this method does not re-check status.
  async updateSpecification(
    tx: Database,
    productSpecId: string,
    data: {
      name: string;
      isMandatory: boolean;
      isDefault: boolean;
      defaultValue: string | null;
      productSpecCharacteristics: ProductSpecCharacteristics;
    },
  ): Promise<{ productSpecId: string }> {
    const [row] = await tx
      .update(productSpecifications)
      .set({
        name: data.name,
        isMandatory: data.isMandatory,
        isDefault: data.isDefault,
        defaultValue: data.defaultValue,
        productSpecCharacteristics: data.productSpecCharacteristics,
      })
      .where(eq(productSpecifications.productSpecId, productSpecId))
      .returning({ productSpecId: productSpecifications.productSpecId });
    if (!row) {
      throw new Error(
        `updateSpecification: specification ${productSpecId} not found`,
      );
    }
    return { productSpecId: row.productSpecId };
  },

  // pm14-spec §3.3. Hard delete — this table's only delete method, ever
  // (project-overview-phase2: "Hard delete is available for a
  // specification, but only on a DRAFT row"). Caller-guaranteed DRAFT
  // target, same as above.
  async deleteSpecification(tx: Database, productSpecId: string): Promise<void> {
    const deleted = await tx
      .delete(productSpecifications)
      .where(eq(productSpecifications.productSpecId, productSpecId))
      .returning({ productSpecId: productSpecifications.productSpecId });
    if (deleted.length === 0) {
      throw new Error(
        `deleteSpecification: specification ${productSpecId} not found`,
      );
    }
  },
};
```

`findByOfferingId`'s existing body is untouched — reproduced above only as a placeholder to show where the three new methods are added within the same exported object literal. Every new method's first parameter is `tx: Database`, matching `branchOfferingAsDraft`/`updateOfferingDraftInPlace`'s "tx-first" shape (pm12/pm13 precedent) rather than the read-only `findByOfferingId`'s `db`-first shape — these are always called from inside a `db.transaction(...)` block in the calling service, never standalone.

### 3.4 Audit event types — `types/audit.ts` (edit — append three entries)

```ts
export const AUDIT_EVENT_TYPES = [
  // ...all existing entries, unchanged...
  "PRODUCT_SPECIFICATION_CREATED",
  "PRODUCT_SPECIFICATION_UPDATED",
  "PRODUCT_SPECIFICATION_DELETED",
] as const;
```

Append only, at whatever position the array currently ends (Codebase state, above — may be right after `"PRODUCT_OFFERING_CREATED"`, or after pm13's two entries if pm13 has already landed). Do not reorder or touch any existing entry. `PRODUCT_PRICE_ADDED` (pm15) and the pm16 lifecycle events append after this unit's three, whenever they land.

### 3.5 Service — `services/product/add-specification.ts` (new)

```ts
import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import type { CreateSpecificationInput } from "@/validation/product/create-specification.schema";

export type AddSpecificationResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" };

// pm14-spec §3.5. Branch-first when the target offering is ACTIVE (Design);
// a create never needs to "locate a counterpart" the way update/delete do,
// since it is adding new content rather than acting on existing content.
export async function addSpecification(
  offeringId: string,
  input: CreateSpecificationInput,
  actorId: string,
): Promise<AddSpecificationResult> {
  const offering = await productOfferingRepository.findDetailById(
    db,
    offeringId,
  );
  if (!offering) {
    return { ok: false, code: "OFFERING_NOT_FOUND" };
  }
  if (offering.lifecycleStatus === "RETIRED") {
    return { ok: false, code: "OFFERING_RETIRED" };
  }

  return db.transaction(async (tx) => {
    let targetOfferingId = offeringId;
    let branched = false;

    if (offering.lifecycleStatus === "ACTIVE") {
      const { offeringId: branchedId } =
        await productOfferingRepository.branchOfferingAsDraft(tx, offeringId);
      targetOfferingId = branchedId;
      branched = true;
    }

    const { productSpecId } =
      await productSpecificationRepository.insertSpecification(tx, {
        refProductOfferingId: targetOfferingId,
        name: input.name,
        isMandatory: input.isMandatory,
        isDefault: input.isDefault,
        defaultValue: input.defaultValue,
        productSpecCharacteristics: input.productSpecCharacteristics,
      });

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_SPECIFICATION_CREATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_SPECIFICATION",
      targetId: productSpecId,
      beforeData: null,
      afterData: {
        offeringId: targetOfferingId,
        ...(branched ? { branchedFromOfferingId: offeringId } : {}),
        name: input.name,
        isMandatory: input.isMandatory,
        isDefault: input.isDefault,
        defaultValue: input.defaultValue,
        productSpecCharacteristics: input.productSpecCharacteristics,
      },
    });

    return {
      ok: true,
      offeringId: targetOfferingId,
      productSpecId,
      branched,
    };
  });
}
```

### 3.6 Service — `services/product/update-specification.ts` (new)

```ts
import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import type { SpecificationCard } from "@/types/product";
import type { UpdateSpecificationInput } from "@/validation/product/update-specification.schema";

export type UpdateSpecificationResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "SPECIFICATION_NOT_FOUND" };

// Shallow equality over a flat string record — productSpecCharacteristics
// is always Record<string, string> (product-spec-characteristics.schema.ts),
// so this is exact, not approximate.
function recordsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
}

// pm14-spec §2 ("locate the cloned counterpart"). branchOfferingAsDraft
// clones every specification field byte-identical with a fresh id
// (pm12-spec §5) — matching on full content against candidates from the
// SAME branch call is exact unless the source offering has two
// specifications with genuinely identical content (disclosed gap, Design).
function findClonedCounterpart(
  target: SpecificationCard,
  candidates: SpecificationCard[],
): SpecificationCard {
  const matches = candidates.filter(
    (candidate) =>
      candidate.name === target.name &&
      candidate.isMandatory === target.isMandatory &&
      candidate.isDefault === target.isDefault &&
      candidate.defaultValue === target.defaultValue &&
      recordsEqual(candidate.characteristics, target.characteristics),
  );
  if (matches.length !== 1) {
    throw new Error(
      `findClonedCounterpart: expected exactly one cloned match for specification ${target.productSpecId}, found ${matches.length}`,
    );
  }
  return matches[0]!;
}

export async function updateSpecification(
  specId: string,
  offeringId: string,
  input: UpdateSpecificationInput,
  actorId: string,
): Promise<UpdateSpecificationResult> {
  const offering = await productOfferingRepository.findDetailById(
    db,
    offeringId,
  );
  if (!offering) {
    return { ok: false, code: "OFFERING_NOT_FOUND" };
  }
  if (offering.lifecycleStatus === "RETIRED") {
    return { ok: false, code: "OFFERING_RETIRED" };
  }

  const specs = await productSpecificationRepository.findByOfferingId(
    db,
    offeringId,
  );
  const current = specs.find((spec) => spec.productSpecId === specId);
  if (!current) {
    return { ok: false, code: "SPECIFICATION_NOT_FOUND" };
  }

  const before = {
    name: current.name,
    isMandatory: current.isMandatory,
    isDefault: current.isDefault,
    defaultValue: current.defaultValue,
    productSpecCharacteristics: current.characteristics,
  };
  const after = {
    name: input.name,
    isMandatory: input.isMandatory,
    isDefault: input.isDefault,
    defaultValue: input.defaultValue,
    productSpecCharacteristics: input.productSpecCharacteristics,
  };

  return db.transaction(async (tx) => {
    let targetOfferingId = offeringId;
    let targetSpecId = specId;
    let branched = false;

    if (offering.lifecycleStatus === "ACTIVE") {
      const { offeringId: branchedId } =
        await productOfferingRepository.branchOfferingAsDraft(tx, offeringId);
      targetOfferingId = branchedId;
      branched = true;

      const clonedSpecs = await productSpecificationRepository.findByOfferingId(
        tx,
        branchedId,
      );
      targetSpecId = findClonedCounterpart(current, clonedSpecs).productSpecId;
    }

    await productSpecificationRepository.updateSpecification(tx, targetSpecId, {
      name: input.name,
      isMandatory: input.isMandatory,
      isDefault: input.isDefault,
      defaultValue: input.defaultValue,
      productSpecCharacteristics: input.productSpecCharacteristics,
    });

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_SPECIFICATION_UPDATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_SPECIFICATION",
      targetId: targetSpecId,
      beforeData: { offeringId: targetOfferingId, ...before },
      afterData: {
        offeringId: targetOfferingId,
        ...(branched ? { branchedFromOfferingId: offeringId } : {}),
        ...after,
      },
    });

    return {
      ok: true,
      offeringId: targetOfferingId,
      productSpecId: targetSpecId,
      branched,
    };
  });
}
```

No no-op guard (Design, §2) — every call writes and audits, even a same-values resubmit, on the direct `DRAFT` path. The branch path never no-ops either, for the same reason `updateOffering`'s branch paths don't (pm13-spec §2): it is a version-creation action, not a field-persistence action.

### 3.7 Service — `services/product/delete-specification.ts` (new)

```ts
import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import type { SpecificationCard } from "@/types/product";

export type DeleteSpecificationResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "SPECIFICATION_NOT_FOUND" };

// Duplicated from update-specification.ts rather than shared (Design,
// §2) — two call sites, same judgment call pm12-spec made for
// resolveFamilyRootId.
function recordsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key]);
}

function findClonedCounterpart(
  target: SpecificationCard,
  candidates: SpecificationCard[],
): SpecificationCard {
  const matches = candidates.filter(
    (candidate) =>
      candidate.name === target.name &&
      candidate.isMandatory === target.isMandatory &&
      candidate.isDefault === target.isDefault &&
      candidate.defaultValue === target.defaultValue &&
      recordsEqual(candidate.characteristics, target.characteristics),
  );
  if (matches.length !== 1) {
    throw new Error(
      `findClonedCounterpart: expected exactly one cloned match for specification ${target.productSpecId}, found ${matches.length}`,
    );
  }
  return matches[0]!;
}

// pm14-spec §2/§3.7. By the time `productSpecificationRepository
// .deleteSpecification` is actually called, its target always belongs to a
// DRAFT offering — either the original (direct path) or the freshly
// branched clone (ACTIVE path) — never the ACTIVE row itself. This is what
// makes guardrail 10 ("Spec-delete unreachable on ACTIVE") true by
// construction (Design).
export async function deleteSpecification(
  specId: string,
  offeringId: string,
  actorId: string,
): Promise<DeleteSpecificationResult> {
  const offering = await productOfferingRepository.findDetailById(
    db,
    offeringId,
  );
  if (!offering) {
    return { ok: false, code: "OFFERING_NOT_FOUND" };
  }
  if (offering.lifecycleStatus === "RETIRED") {
    return { ok: false, code: "OFFERING_RETIRED" };
  }

  const specs = await productSpecificationRepository.findByOfferingId(
    db,
    offeringId,
  );
  const current = specs.find((spec) => spec.productSpecId === specId);
  if (!current) {
    return { ok: false, code: "SPECIFICATION_NOT_FOUND" };
  }

  const before = {
    name: current.name,
    isMandatory: current.isMandatory,
    isDefault: current.isDefault,
    defaultValue: current.defaultValue,
    productSpecCharacteristics: current.characteristics,
  };

  return db.transaction(async (tx) => {
    let targetOfferingId = offeringId;
    let targetSpecId = specId;
    let branched = false;

    if (offering.lifecycleStatus === "ACTIVE") {
      const { offeringId: branchedId } =
        await productOfferingRepository.branchOfferingAsDraft(tx, offeringId);
      targetOfferingId = branchedId;
      branched = true;

      const clonedSpecs = await productSpecificationRepository.findByOfferingId(
        tx,
        branchedId,
      );
      targetSpecId = findClonedCounterpart(current, clonedSpecs).productSpecId;
    }

    await productSpecificationRepository.deleteSpecification(tx, targetSpecId);

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_SPECIFICATION_DELETED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_SPECIFICATION",
      targetId: targetSpecId,
      beforeData: {
        offeringId: targetOfferingId,
        ...(branched ? { branchedFromOfferingId: offeringId } : {}),
        ...before,
      },
      afterData: null,
    });

    return {
      ok: true,
      offeringId: targetOfferingId,
      productSpecId: targetSpecId,
      branched,
    };
  });
}
```

### 3.8 Guardrail test — `tests/guardrails/product-module-boundaries.test.ts` (edit — extend `PRODUCT_WRITE_SERVICE_FILES` only)

```ts
const PRODUCT_WRITE_SERVICE_FILES = new Set([
  "create-offering.ts",
  // "update-offering.ts" — present here already if pm13 landed first; do
  // not remove it if so.
  "add-specification.ts",
  "update-specification.ts",
  "delete-specification.ts",
]);
```

The existing "no product read path imports the audit-log write path" test (§3.5 above's citation) scans every file under `services/product/` except those named in this set. `add-specification.ts`, `update-specification.ts`, and `delete-specification.ts` all legitimately import `insertAuditEvent` (Design, §2), so without this edit the guardrail would start failing the moment this unit's service files exist — not because anything is wrong, but because the test's exclusion set is additive and each backend unit that adds a write service under `services/product/` is responsible for adding its own filename(s) to it. This is a strictly additive edit to one `Set` literal — no other line in the test file changes. (Flagging, not fixing: `pm13-spec.md` does not mention this same edit for `update-offering.ts`, which appears to be a gap in that unit's own diff hygiene — out of scope to fix here, but if pm13 lands without it, its own guardrail run will fail for the same reason and need the identical one-line addition.)

### 3.9 No schema change, no Server Action, no UI in this unit

`db/schema/product.ts` is untouched — this unit writes existing columns only, on a table pm10/pm11 already shipped. `actions/product/create-specification.action.ts`, `update-specification.action.ts`, `delete-specification.action.ts`, and `components/products/manage/specification-form.tsx` all belong to pm21. Per the build plan's boundary line and dependency graph, no file under `actions/`, `components/`, or `app/` changes in this unit.

## 4. Dependencies

**No new npm packages.** Zod, Drizzle, and the Postgres driver are already installed and already used by every existing validation schema, repository, and write service in this codebase. **No DB extensions, no migration.**

## 5. Verify when done

**Diff hygiene**
- [ ] `git status` shows only: `validation/product/create-specification.schema.ts` (new), `validation/product/update-specification.schema.ts` (new), `db/repositories/product-specification.ts` (three new methods added; `findByOfferingId` untouched), `types/audit.ts` (exactly three new array entries, appended last), `services/product/add-specification.ts` (new), `services/product/update-specification.ts` (new), `services/product/delete-specification.ts` (new), `tests/guardrails/product-module-boundaries.test.ts` (one `Set` literal extended by exactly three entries). No `actions/`, `components/`, `app/`, or `db/schema/` changes.
- [ ] `db/repositories/product-offering.ts` is untouched by this unit — `branchOfferingAsDraft`'s own file gains nothing here (this unit only *calls* it).

**Backend correctness — direct `DRAFT` path (create)**
- [ ] Calling `addSpecification(draftId, input, actorId)` against a seeded `DRAFT` offering inserts exactly one new row into `product_specifications` with `ref_product_offering_id = draftId` and every field matching `input`, and leaves the offering's own row and its other specification/price rows unchanged.
- [ ] Exactly one audit row appears: `event_type = 'PRODUCT_SPECIFICATION_CREATED'`, `target_entity = 'PRODUCT_SPECIFICATION'`, `target_id` equal to the new spec's id, `before_data = null`, `after_data` matching the submitted fields plus `offeringId: draftId` and no `branchedFromOfferingId` key.
- [ ] Result is `{ ok: true, offeringId: draftId, productSpecId: <newId>, branched: false }`.

**Backend correctness — branch-first path (create)**
- [ ] Calling `addSpecification` against an `ACTIVE` offering (e.g. the seed's "5G Nationwide Service Plan") leaves that row and every one of its existing specification/price rows byte-identical afterward (re-fetch and compare against a pre-call snapshot).
- [ ] The call produces exactly one new sibling `DRAFT` row (via `branchOfferingAsDraft`) whose specifications are the source's original set **plus** the newly added one; the new spec's `ref_product_offering_id` points at the new draft, not the source.
- [ ] The audit row's `target_id` is the new spec's id (which belongs to the new draft), `after_data.offeringId` equals the new draft's id, and `after_data.branchedFromOfferingId` equals the source `ACTIVE` offering's id.
- [ ] Result is `{ ok: true, offeringId: <newDraftId>, productSpecId: <newSpecId>, branched: true }` where `<newDraftId>` differs from the source id.

**Backend correctness — direct `DRAFT` path (update)**
- [ ] Calling `updateSpecification(specId, draftId, input, actorId)` against a spec belonging to a `DRAFT` offering updates that same row's fields in place, in the same table row (same `product_spec_id`), and leaves every other specification/price row and the offering row itself unchanged.
- [ ] Exactly one audit row appears: `event_type = 'PRODUCT_SPECIFICATION_UPDATED'`, `target_id` equal to `specId` (unchanged), `before_data` matching the pre-edit values, `after_data` matching the submitted values, neither carrying a `branchedFromOfferingId` key.
- [ ] Calling with field values identical to the spec's current values still performs a real `UPDATE` and writes a real audit row (no no-op short-circuit — Design, §2).
- [ ] Result is `{ ok: true, offeringId: draftId, productSpecId: specId, branched: false }`.

**Backend correctness — branch-first path (update)**
- [ ] Calling `updateSpecification` against a spec belonging to an `ACTIVE` offering leaves that offering row, that exact specification row (same `product_spec_id`, same content), and every other specification/price row on the source untouched afterward.
- [ ] The call produces exactly one new sibling `DRAFT` whose specifications are the source's original set, except the one corresponding to `specId` carries the edited fields instead of its original ones; every other cloned spec on the new draft is byte-identical to its source counterpart.
- [ ] The edited spec's row on the new draft has a `product_spec_id` different from the original `specId` (a fresh clone id, then updated) — confirmed by checking the original `specId` still exists, unmodified, on the source offering.
- [ ] The audit row's `target_id` is the *new draft's* edited spec's id (not the original `specId`), `before_data`/`after_data.offeringId` reflects the new draft, `after_data.branchedFromOfferingId` equals the source offering's id.
- [ ] Result's `productSpecId` differs from the input `specId`; `branched: true`.
- [ ] Seeding a source offering with two or more specifications that differ from each other in at least one field, then editing one of them, produces exactly one changed clone on the new draft — confirms `findClonedCounterpart` picks the right row when multiple candidates exist, not just when there's only one.

**Backend correctness — direct `DRAFT` path (delete)**
- [ ] Calling `deleteSpecification(specId, draftId, actorId)` against a spec belonging to a `DRAFT` offering removes exactly that row from `product_specifications`; every other row (on this offering and others) is unaffected.
- [ ] Exactly one audit row appears: `event_type = 'PRODUCT_SPECIFICATION_DELETED'`, `target_id` equal to `specId`, `before_data` matching the spec's content immediately before deletion, `after_data = null`.
- [ ] Result is `{ ok: true, offeringId: draftId, productSpecId: specId, branched: false }`.

**Backend correctness — branch-first path (delete)**
- [ ] Calling `deleteSpecification` against a spec belonging to an `ACTIVE` offering leaves that offering row and every one of its existing specification rows (including the "deleted" one) byte-identical and fully present afterward.
- [ ] The call produces exactly one new sibling `DRAFT` whose specifications are the source's original set **minus** the one corresponding to `specId` — one fewer row than the source, every remaining row byte-identical in content to its source counterpart.
- [ ] The audit row's `target_id` is the id of the row that was deleted **from the new draft** (the clone's own fresh id, not the original `specId`), `before_data.offeringId` reflects the new draft, `before_data.branchedFromOfferingId` equals the source offering's id, `after_data = null`.
- [ ] Result's `productSpecId` differs from the input `specId`; `branched: true`.

**Backend correctness — not-found and terminal-status guards**
- [ ] `addSpecification`/`updateSpecification`/`deleteSpecification` each return `{ ok: false, code: "OFFERING_NOT_FOUND" }` for a nonexistent `offeringId` and write nothing.
- [ ] Each returns `{ ok: false, code: "OFFERING_RETIRED" }` against a `RETIRED` offering, calls neither `branchOfferingAsDraft` nor any `product-specification.ts` write method, and writes no audit row.
- [ ] `updateSpecification`/`deleteSpecification` each return `{ ok: false, code: "SPECIFICATION_NOT_FOUND" }` when `specId` doesn't exist at all, and separately when `specId` exists but belongs to a *different* offering than the given `offeringId` — both cases write nothing.

**Boundary**
- [ ] `services/product/add-specification.ts`, `update-specification.ts`, and `delete-specification.ts` contain no `next/*` import, no `"use server"` directive.
- [ ] `db/repositories/product-specification.ts` contains no import of `@/db/repositories/audit.repository`, no reference to `insertAuditEvent` or `AUDIT_LOG` — the guardrail's "no product read path imports the audit-log write path" check continues to pass for this file (repositories never audit).
- [ ] `tests/guardrails/product-module-boundaries.test.ts`'s "no code path calls `deleteSpecification` against an `ACTIVE` offering" style assertion — if pm24 has not yet added it structurally, manually confirm by source inspection that `delete-specification.ts`'s only call to `productSpecificationRepository.deleteSpecification` is reached either directly (offering already `DRAFT`) or after a `branchOfferingAsDraft` call (offering was `ACTIVE`, target is now the clone) — never with the original `ACTIVE` row's own spec id.
- [ ] No `actions/product/` directory or file exists yet as a result of this unit (that's pm21).

**Build gates**
- [ ] `npm run typecheck` green — `CreateSpecificationInput`, `UpdateSpecificationInput`, `AddSpecificationResult`, `UpdateSpecificationResult`, `DeleteSpecificationResult`, and every new repository method's parameter/return types all resolve with no manual `any`.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] Existing Phase 1, pm11, and pm12 tests still pass unmodified — this unit adds two schemas, three repository methods, three service files, and one guardrail `Set` extension; it touches no existing method's behavior or signature.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy, not the plan-folder mirror) gets a pm14 entry with the commit reference, once this actually ships.

Any failing item means the unit is not done. Units pm21 (Specification management UI) depends on all three services' exact result shapes — including `offeringId`/`productSpecId`/`branched` — existing and verified; do not start it until every item above passes. Unit pm24 (ship gate) depends on this unit's guardrail-10 behavior holding, whether asserted structurally by then or only by construction as verified here.
