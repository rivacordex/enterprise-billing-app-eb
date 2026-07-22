# PM16 — Backend: Activation & Retirement/Discard

- **Unit:** 16 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm11 (`insertOffering` shipped — something exists to activate). Units pm14 and pm15 (specification and price write services shipped — this unit's own precondition-fixture tests populate a `DRAFT` through `addSpecification`/`insertPrice`, not raw fixture SQL, per the build plan's own text). Transitively, Unit pm12 (`branchOfferingAsDraft`) is also guaranteed shipped by the time this unit starts, since both pm14 and pm15 depend on it — this unit does not call `branchOfferingAsDraft` itself (activation and retirement never branch), but reuses the same one-hop family-resolution convention pm12 established.
- **Authorizing sections:** `prodmgmt-project-overview-phase2.md` "Lifecycle transitions" ("`DRAFT → ACTIVE`: requires at least one price row and all mandatory specifications resolved... Automatically retires the family's previous active version, if any, as part of the same action... `ACTIVE → RETIRED` (\"Retire\") and `DRAFT → RETIRED` (\"Discard\")... `RETIRED` is terminal") and Success Criteria ("Activating a new version of a family that already has an active version automatically retires the previous one in the same action; at no point do both appear `ACTIVE` simultaneously, including under two near-simultaneous activation attempts" / "Attempting to activate a `DRAFT` with no prices, or with unresolved mandatory specifications, is rejected with a specific error and the offering stays `DRAFT`"); `_change-product-crud-plan.md` Decision 5 ("Activation preconditions... at least one price row exists, and at least one specification exists with every mandatory specification resolved (a `default_value` or an explicit value set). Failing either blocks activation with a clear, specific error — not a generic 'cannot activate.'"); `prodmgmt-architecture-phase2.md` §6 Inv. 13 (single-active-per-family enforced transactionally, not by a DB constraint — "`activateOffering` re-reads and re-checks... inside the transaction before flipping status — the same defense-in-depth pattern `roles-write.service.ts`'s `deleteRole` already uses to close a race window... a deliberate, documented trade-off, not an oversight") and Inv. 6 amendment (at most one row per family `ACTIVE` at a time); `prodmgmt-code-standards-phase2.md` §1 rule 11 ("Discard and Retire are the same repository call with different audit events... Do not fork this into two repository methods"), §6 new rules 11 ("Single-active-per-family is enforced transactionally... the same in-transaction re-check pattern `deleteRole` uses... this was a deliberate, reviewed trade-off, not an oversight to 'fix' later") and 13 ("Reason/comment on activation and retirement/discard is captured in the audit event payload, not a new column. `insertAuditEvent`'s `afterData` carries `{ ...fields, transitionReason: reason ?? null }`. No `product_offering` schema impact."), and §9 guardrail 8 ("Single-active-per-family — activating a version retires any sibling `ACTIVE` version in the same transaction; under two near-simultaneous activation attempts on siblings, exactly one family member ends up `ACTIVE`, never zero or two."); `pm99-build-plan-phase2.md` Unit pm16 (this unit's literal contract); `pm11-spec.md` (the insert-plus-audit transaction pairing and "repositories never audit" convention); `pm12-spec.md` (the inline, non-extracted one-hop family-resolution expression this unit duplicates a second time — pm12-spec explicitly anticipates this: "Unit pm16 will need the same one-liner inside `activateOffering` before it calls `findActiveInFamily(tx, resolvedRootId)`"); `pm14-spec.md`/`pm15-spec.md` (the "read preconditions ahead of the transaction, write inside it" shape this unit's own precondition checks continue); `services/roles/roles-write.service.ts`'s `deleteRole` (the in-transaction re-check-then-act pattern this unit's `activateOffering` extends with row locking — see Design for why a plain re-read, unlike `deleteRole`'s, is not sufficient here).
- **Codebase state assumed at start (re-verify before implementing):** Unit pm11 confirmed shipped as of this writing — `db/repositories/product-offering.ts` exports exactly `findList`, `findDetailById`, `insertOffering`; `types/audit.ts`'s `AUDIT_EVENT_TYPES` ends at `"PRODUCT_OFFERING_CREATED"`; `services/product/` has `create-offering.ts`, `list-offerings.ts`, `get-offering-detail.ts`; `validation/product/` has `create-offering.schema.ts`, `offering-list.schema.ts`, `pricing-characteristics.schema.ts`, `product-spec-characteristics.schema.ts`. **Units pm12, pm13, pm14, and pm15 are not yet shipped as of this writing.** Do not begin this unit until every item in `pm12-spec.md` §5, `pm14-spec.md` §5, and `pm15-spec.md` §5 passes (pm13 is not a direct dependency of this unit per the build plan's dependency line, but will very likely have landed by the time this unit starts since it shares pm12 as a common dependency — if so, `db/repositories/product-offering.ts` will additionally export `updateOfferingDraftInPlace`, and `types/audit.ts` will additionally include `"PRODUCT_OFFERING_UPDATED"`/`"PRODUCT_OFFERING_BRANCHED"` ahead of this unit's own entries; either way, this unit only ever appends). This spec is written assuming that, by the time implementation starts: `db/repositories/product-offering.ts` exports `branchOfferingAsDraft` (pm12); `db/repositories/product-specification.ts` exports `insertSpecification`/`updateSpecification`/`deleteSpecification` and `services/product/add-specification.ts` exists (pm14); `db/repositories/product-offering-price.ts` exports `insertPrice` and `services/product/insert-price.ts` exists (pm15). `tests/guardrails/product-module-boundaries.test.ts`'s `PRODUCT_WRITE_SERVICE_FILES` set currently contains only `"create-offering.ts"`; by the time this unit starts it will also contain whatever pm13/pm14/pm15 each added — this unit adds its own two filenames to whatever that set already contains. No `activateOffering`, `retireOffering`, or `findActiveInFamily` exist yet anywhere in `db/repositories/product-offering.ts`. No `services/product/activate-offering.ts` or `retire-offering.ts` exist yet. No `validation/product/activate-offering.schema.ts` or `retire-offering.schema.ts` exist yet.

---

## 1. Goal

Let a `products:EDIT`/`DELETE` caller move a product offering through the terminal stages of its lifecycle: activating a `DRAFT` requires at least one price row and every mandatory specification resolved, flips it to `ACTIVE`, and — inside the same transaction — automatically retires whichever other version in its family was previously `ACTIVE`, with the single-active-per-family invariant enforced by a row-locked, transactional re-check so that even two near-simultaneous activation attempts on sibling drafts leave exactly one `ACTIVE`; retiring or discarding an offering both resolve to the identical `RETIRED` status through one repository call, distinguished only by which audit event type the calling service logs.

## 2. Design

**Where `offeringId` lives — a function parameter, not a schema field.** Same convention every prior mutation unit in this phase has used: `activate-offering.schema.ts`/`retire-offering.schema.ts`'s only field is `reason` (build plan's literal text). `activateOffering(offeringId, input, actorId)` and `retireOffering(offeringId, input, actorId)` both take the target id as their own parameter — the caller (pm23's Server Actions, later) always already knows which row it's acting on from the selected table row.

**`activateOffering` and `findActiveInFamily` are repository-level methods, not private helpers.** Unlike pm12's `resolveNextVersion` (a single-caller helper kept unexported), the build plan and `prodmgmt-code-standards-phase2.md`'s file tree both name `findActiveInFamily` as its own thing "in the offering repository," on equal footing with `activateOffering` itself, and `prodmgmt-code-standards-phase2.md` §6.7 explicitly calls it "a repository primitive, not an anti-pattern to avoid." Both are added as public methods on the existing `productOfferingRepository` object, so `findActiveInFamily` is independently testable — the build plan's own visible result ("activating a second draft... retires that row automatically... and this holds under two near-simultaneous activation attempts") is a property of `findActiveInFamily`'s locking behavior specifically, not just of `activateOffering`'s overall control flow, and deserves its own direct test coverage.

**Family resolution is inlined a second time, per pm12-spec's own prediction.** `const rootId = draft.familyOfferingId ?? draft.productOfferingId` is duplicated here exactly as `pm12-spec.md` anticipated ("this unit does not speculatively factor that out into a shared exported `resolveFamilyRootId`... Unit pm16 will need the same one-liner"). Two call sites (`branchOfferingAsDraft`, `activateOffering`) still costs less than an abstraction neither one has needed twice yet.

**Why a plain re-read (`deleteRole`'s pattern, unmodified) is not sufficient here, and what this unit adds on top of it.** `deleteRole`'s in-transaction re-check reads a count immediately before its own delete, inside the same transaction, narrowing the race window between an outer pre-check and the write — but it has no row lock of its own; its real backstop is the FK relationship between `role_assign` and `roles` (a concurrent assignment insert would fail against a role that's mid-delete, or the delete would fail against a role with a fresh assignment, depending on ordering — either way Postgres's own FK enforcement is the last line of defense). Inv. 13 has no equivalent DB-level backstop: `prodmgmt-architecture-phase2.md` §6 is explicit that a plain unique index can't express "at most one `ACTIVE` row per family" because the root's `family_offering_id` is `NULL` and NULLs never collide in a unique index. Without a DB constraint, a plain re-read is not actually sufficient to make `prodmgmt-code-standards-phase2.md` §9 guardrail 8 true under real concurrency: consider two `DRAFT` siblings, `V2` and `V3`, in a family whose currently `ACTIVE` member is `V1`, both calling `activateOffering` at nearly the same instant.
- If the in-transaction check were `SELECT ... WHERE lifecycle_status = 'ACTIVE' AND (id = rootId OR family_offering_id = rootId)` with no lock, both transactions' snapshots (taken at each query's own start, under Postgres's default READ COMMITTED) would independently see `V1` as the only `ACTIVE` row, both would retire `V1` and activate their own target, and the result would be **two** `ACTIVE` rows (`V2` and `V3`) — guardrail 8 broken.
- Adding `FOR UPDATE` to that same status-filtered query is *still* insufficient: if transaction A locks and then retires `V1` (making it `RETIRED`) and activates `V2`, transaction B — which was blocked waiting on `V1`'s lock — wakes up once A commits, but Postgres re-evaluates *only the row it was already trying to lock* (`V1`) against the query's `WHERE lifecycle_status = 'ACTIVE'` clause; `V1` no longer matches (it's `RETIRED` now), so it's silently dropped from B's result set. B never learns that `V2` became `ACTIVE` in the meantime, because `V2` was never a candidate row in B's original query plan. B would then see "no `ACTIVE` sibling" and activate `V3` directly — again, two `ACTIVE` rows.

The fix this unit uses: `findActiveInFamily(tx, rootId)` locks **every row in the family, unconditionally, regardless of current status** — `WHERE product_offering_id = rootId OR family_offering_id = rootId FOR UPDATE`, with the `ACTIVE` filter applied afterward, in application code, over the locked rows. Because the row-selection predicate depends only on immutable identity columns (`product_offering_id`, `family_offering_id`), not on the mutable `lifecycle_status` column, both transactions target the *same* fixed row set from the start. Transaction B blocks on the whole family (including `V1`, `V2`, and `V3`'s own rows) until transaction A commits, then re-reads that same fixed row set with up-to-date data — which now shows `V2` as `ACTIVE` — and correctly retires `V2` before activating `V3`. The end state has exactly one `ACTIVE` row, `V3`, with `V2` and `V1` both `RETIRED` — satisfying guardrail 8's "exactly one family member ends up `ACTIVE`, never zero or two," even though *both* activation calls succeed (sequentially, not simultaneously) rather than one being rejected. This is the concrete mechanism behind the build plan's own words "Inv. 13's transactional re-check, same defense-in-depth pattern as `deleteRole`'s in-transaction assignment count" — same *pattern* (re-check inside the transaction, right before acting), extended with row locking because this invariant, unlike `deleteRole`'s, has no DB-level backstop to fall back on.

**This is the first use of `.for("update")` anywhere in this codebase.** No prior repository method locks rows — `drizzle-orm` (already at `^0.45.2`) supports `.for("update")` as a standard query-builder method; no new package is needed.

**Precondition checks (price count, mandatory-spec resolution) are read ahead of the transaction, not re-checked inside it — a narrower guarantee than Inv. 13's, and deliberately so.** `_change-product-crud-plan.md`'s Decision 5 defines "resolved" precisely: a mandatory specification counts as resolved when it has "a `default_value`... set" — i.e., `isMandatory === true` implies `defaultValue !== null`. This unit reads `productOfferingPriceRepository.findByOfferingIdWithDerivedEnd` and `productSpecificationRepository.findByOfferingId` once, before opening the transaction, mirroring every prior unit's "read state, then act" shape (pm13's no-op comparison, pm15's backdating check). Unlike the single-active-per-family invariant, nothing in the build plan or architecture addendum asks for these preconditions to be re-verified with a lock inside the transaction — a specification or price row being deleted between this check and the commit is a real but disclosed gap, no different in kind from pm12's disclosed non-locked version-numbering race: closing it would need locking the offering's own spec/price rows too, and nothing here asks for that additional guarantee the way Inv. 13 explicitly does.

**Two named precondition failure codes, matching the two named failure categories in the authorizing docs — not more, not fewer.** `prodmgmt-project-overview-phase2.md`'s Success Criteria names exactly two: "no prices" and "unresolved mandatory specifications." Reading Decision 5's own conjunction ("at least one specification exists **with** every mandatory specification resolved") literally, "zero specifications at all" and "some mandatory specification lacks a resolved value" both fail the *same* single named condition — so both map to one code, `SPECIFICATIONS_NOT_RESOLVED`, rather than inventing a third, undocumented category (`NO_SPECIFICATIONS`) the authorizing docs never name.

**Result shape carries `supersededOfferingId`, mirroring `branched`/`backdated`'s "tell the caller what else happened" precedent.**

```ts
export type ActivateOfferingResult =
  | { ok: true; offeringId: string; supersededOfferingId: string | null }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT" }
  | { ok: false; code: "NO_PRICE_ROWS" }
  | { ok: false; code: "SPECIFICATIONS_NOT_RESOLVED" };

export type RetireOfferingResult =
  | {
      ok: true;
      offeringId: string;
      eventType: "PRODUCT_OFFERING_RETIRED" | "PRODUCT_OFFERING_DISCARDED";
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" };
```

`OFFERING_NOT_DRAFT` covers both an `ACTIVE` and a `RETIRED` target — activation is only ever valid from `DRAFT`, unlike pm13/pm14/pm15's routing (where an `ACTIVE` target is a *valid*, branch-triggering case); there is no branch-first option for activation, so any non-`DRAFT` source is simply rejected. `retireOffering`'s failure code reuses the exact `OFFERING_RETIRED` name pm13/pm14/pm15 each already use for "this target is already retired" — deliberately, for cross-service consistency (a future caller checking `code === "OFFERING_RETIRED"` gets the same meaning regardless of which service returned it), rather than inventing a same-meaning `OFFERING_ALREADY_RETIRED` synonym.

**`eventType` on a successful retire/discard is returned to the caller, not just written to the audit log** — the same "hand back what happened, not just whether it happened" precedent as `branched`/`backdated` — useful for pm23's UI to confirm which of "Retired" / "Discarded" actually occurred without re-deriving it from the offering's pre-call status itself.

**`transitionReason` — one literal payload key, shared by both services, always present.** `prodmgmt-code-standards-phase2.md` §6 rule 13 is explicit and exact: `insertAuditEvent`'s `afterData` carries `{ ...fields, transitionReason: reason ?? null }` — always present as a key, `null` when no reason was supplied, never conditionally omitted the way `branchedFromOfferingId` is in pm14/pm15's audit payloads. This unit follows that literal shape in both `PRODUCT_OFFERING_ACTIVATED`'s and `PRODUCT_OFFERING_RETIRED`/`_DISCARDED`'s `afterData`. `PRODUCT_OFFERING_SUPERSEDED`'s payload does **not** get a `transitionReason` key — rule 13 names "activation and retirement/discard" specifically, and the actor's reason (if given) explains *why they activated this draft*, not *why the sibling was retired as an automatic consequence*; the superseded row's own audit payload instead carries `supersededByOfferingId` so a reviewer can trace which row caused the supersession, mirroring pm13/pm14/pm15's `branchedFromOfferingId` transparency convention.

**Repository methods take no `actorId` — attribution is the calling service's job, not this primitive's**, exactly matching `branchOfferingAsDraft`'s own precedent (pm12-spec §2) and the build plan's literal signatures (`activateOffering(tx, draftId)`, `retireOffering(tx, offeringId)` — no third parameter).

**`retireOffering`'s repository method has no status backstop at all — not even the `WHERE lifecycle_status = 'DRAFT'`-style guard `updateOfferingDraftInPlace` uses.** The build plan is explicit: "sets `RETIRED` unconditionally regardless of prior status." This is also `prodmgmt-code-standards-phase2.md` §1 rule 11's literal text: "Do not fork this into two repository methods — the DB-level operation is identical, only the audit semantics differ." The already-`RETIRED` guard (`OFFERING_RETIRED`) lives entirely in the service, ahead of the transaction — the repository method will happily set an already-`RETIRED` row to `RETIRED` again if called directly, by design, since "unconditionally" is the literal contract.

**`activateOffering`'s final status-flip *does* carry a `WHERE lifecycle_status = 'DRAFT'` backstop**, mirroring `updateOfferingDraftInPlace`'s own defense-in-depth reasoning (pm13-spec §2: "a backstop, not the primary check... closes the window against a future implementer calling this method directly without [the] surrounding check") — the service already verifies `DRAFT` status before opening the transaction, but the repository method doesn't trust that alone, the same discipline `updateOfferingDraftInPlace` established. Because `findActiveInFamily`'s `FOR UPDATE` call already locks the draft's own row (it's a member of the family being locked), this backstop also closes the same-row double-activation race for free: a second concurrent call targeting the identical `draftId` blocks on the family lock, and by the time it's unblocked the row's status is no longer `DRAFT`, so its own conditional `UPDATE` affects zero rows and throws — an acceptable, unhandled edge case (no authorizing doc names a typed result for "someone else already activated the exact row you were activating"), consistent with `insertOffering`/`branchOfferingAsDraft`'s existing "throw on unexpected zero-row result" discipline.

**No visual/UI design in this unit** — backend service/data-access layer only, per the build plan's boundary. `actions/product/activate-offering.action.ts`, `retire-offering.action.ts`, and `retire-offering-dialog.tsx` all belong to pm23.

## 3. Implementation

### 3.1 Validation — `validation/product/activate-offering.schema.ts` (new)

```ts
import { z } from "zod";

export const activateOfferingSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, "Reason must be 500 characters or fewer")
    .optional(),
});

export type ActivateOfferingInput = z.infer<typeof activateOfferingSchema>;
```

The build plan's literal field list is `{ reason: z.string().max(500).optional() }`; `.trim()` is added here for consistency with every other optional free-text field in `validation/product/**` (`defaultValue`, `glCode`) — not a build-plan requirement, a house-convention addition. An empty-string submission (`""`, distinct from an omitted key) still parses successfully — no `.min(1)` — the service layer, not the schema, decides whether an empty string counts as "no reason" (see §3.5/§3.6: `reason || null`, not `reason ?? null`, specifically to fold `""` and `undefined` into the same `null` outcome).

### 3.2 Validation — `validation/product/retire-offering.schema.ts` (new)

```ts
import { z } from "zod";

export const retireOfferingSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, "Reason must be 500 characters or fewer")
    .optional(),
});

export type RetireOfferingInput = z.infer<typeof retireOfferingSchema>;
```

Field-identical to `activateOfferingSchema` — both are literally the same one-field shape per the build plan, kept as two separate files (not one shared schema re-exported twice) because `create-offering.schema.ts`/`update-offering.schema.ts` established "one file per mutation" as this module's convention, and a future divergence (e.g., a required reason on discard only) shouldn't need a file split done retroactively.

### 3.3 Repository — `db/repositories/product-offering.ts` (edit — add `findActiveInFamily`, `activateOffering`, `retireOffering`)

No new imports needed beyond what pm12 already added to this file (`and`, `or`, `eq` are all already imported by the time this unit starts).

Add three new methods to the existing `productOfferingRepository` object (alongside `findList` / `findDetailById` / pm11's `insertOffering` / pm12's `branchOfferingAsDraft` / pm13's `updateOfferingDraftInPlace`, if pm13 has landed):

```ts
// pm16-spec §3.3. Locks every row belonging to the family — not just
// whichever one currently reads ACTIVE — because the row set this method
// locks must be fixed by immutable identity (id / family_offering_id), not
// by the mutable lifecycle_status column, for the FOR UPDATE re-check to
// actually serialize two concurrent activations on sibling drafts (Design;
// architecture-phase2 §6 Inv. 13). Returns the family's current ACTIVE
// member, if any, already locked for the caller's own transaction.
async findActiveInFamily(
  tx: Database,
  rootId: string,
): Promise<{ offeringId: string } | null> {
  const familyRows = await tx
    .select({
      offeringId: productOffering.productOfferingId,
      lifecycleStatus: productOffering.lifecycleStatus,
    })
    .from(productOffering)
    .where(
      or(
        eq(productOffering.productOfferingId, rootId),
        eq(productOffering.familyOfferingId, rootId),
      ),
    )
    .for("update");

  const active = familyRows.find((row) => row.lifecycleStatus === "ACTIVE");
  return active ? { offeringId: active.offeringId } : null;
},

// pm16-spec §3.3. Caller (services/product/activate-offering.ts) has
// already verified draftId is DRAFT and meets both activation
// preconditions before this is ever called (Design) — this method's own
// job is exactly the transactional single-active-per-family re-check
// (Inv. 13), not precondition enforcement. No actorId parameter —
// attribution is the caller's job (Design, mirroring branchOfferingAsDraft).
async activateOffering(
  tx: Database,
  draftId: string,
): Promise<{ offeringId: string; supersededOfferingId: string | null }> {
  const [draft] = await tx
    .select({
      productOfferingId: productOffering.productOfferingId,
      familyOfferingId: productOffering.familyOfferingId,
    })
    .from(productOffering)
    .where(eq(productOffering.productOfferingId, draftId))
    .limit(1);
  if (!draft) {
    throw new Error(`activateOffering: offering ${draftId} not found`);
  }

  // One-hop family resolution (architecture-phase2 §3), duplicated from
  // branchOfferingAsDraft's own inline resolution — pm12-spec's own
  // prediction (Design).
  const rootId = draft.familyOfferingId ?? draft.productOfferingId;

  const activeSibling = await productOfferingRepository.findActiveInFamily(
    tx,
    rootId,
  );

  if (activeSibling) {
    const retired = await tx
      .update(productOffering)
      .set({ lifecycleStatus: "RETIRED" })
      .where(eq(productOffering.productOfferingId, activeSibling.offeringId))
      .returning({ offeringId: productOffering.productOfferingId });
    if (retired.length === 0) {
      throw new Error(
        `activateOffering: failed to retire sibling ${activeSibling.offeringId}`,
      );
    }
  }

  const [activated] = await tx
    .update(productOffering)
    .set({ lifecycleStatus: "ACTIVE" })
    .where(
      and(
        eq(productOffering.productOfferingId, draftId),
        eq(productOffering.lifecycleStatus, "DRAFT"),
      ),
    )
    .returning({ offeringId: productOffering.productOfferingId });
  if (!activated) {
    throw new Error(
      `activateOffering: offering ${draftId} not found or not DRAFT`,
    );
  }

  return {
    offeringId: activated.offeringId,
    supersededOfferingId: activeSibling?.offeringId ?? null,
  };
},

// pm16-spec §3.3. Unconditional — sets RETIRED regardless of the row's
// prior status (build plan's literal wording; code-standards-phase2 §1
// rule 11: "Do not fork this into two repository methods"). The
// already-RETIRED guard lives entirely in the calling service, ahead of
// the transaction (Design) — this method has no WHERE-status backstop.
async retireOffering(
  tx: Database,
  offeringId: string,
): Promise<{ offeringId: string }> {
  const [row] = await tx
    .update(productOffering)
    .set({ lifecycleStatus: "RETIRED" })
    .where(eq(productOffering.productOfferingId, offeringId))
    .returning({ offeringId: productOffering.productOfferingId });
  if (!row) {
    throw new Error(`retireOffering: offering ${offeringId} not found`);
  }
  return { offeringId: row.offeringId };
},
```

`lastModified`/`lastEditedBy` are untouched by both `activateOffering` and `retireOffering` — deliberately: those columns record who last edited the offering's own content fields (`name`/`isSellable`/`billingOnly`, per `updateOfferingDraftInPlace`), not lifecycle transitions, and the audit log (§3.4–§3.6 below) already independently records who performed the activation/retirement and when. No authorizing doc asks for these columns to be stamped by a status-only transition, so this unit does not invent that behavior.

### 3.4 Audit event types — `types/audit.ts` (edit — append four entries)

```ts
export const AUDIT_EVENT_TYPES = [
  // ...all existing entries, unchanged...
  "PRODUCT_OFFERING_ACTIVATED",
  "PRODUCT_OFFERING_SUPERSEDED",
  "PRODUCT_OFFERING_RETIRED",
  "PRODUCT_OFFERING_DISCARDED",
] as const;
```

Append only, at whatever position the array currently ends (Codebase state, above) — do not reorder or touch any existing entry. This order matches `prodmgmt-architecture-phase2.md` §5's own listing order for these four event types. No further `PRODUCT_*` entries are added by any later unit in this phase — this is the last of the eleven Phase 2 event types (`_CREATED`, `_UPDATED`, `_BRANCHED` from pm13; `PRODUCT_SPECIFICATION_CREATED`/`_UPDATED`/`_DELETED` from pm14; `PRODUCT_PRICE_ADDED` from pm15; these four from this unit).

### 3.5 Service — `services/product/activate-offering.ts` (new)

```ts
import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import type { ActivateOfferingInput } from "@/validation/product/activate-offering.schema";

export type ActivateOfferingResult =
  | { ok: true; offeringId: string; supersededOfferingId: string | null }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT" }
  | { ok: false; code: "NO_PRICE_ROWS" }
  | { ok: false; code: "SPECIFICATIONS_NOT_RESOLVED" };

// pm16-spec §3.5. Preconditions are read ahead of the transaction (Design)
// — a specification or price row disappearing between this check and the
// commit is a disclosed, unlocked gap, unlike Inv. 13's single-active-per-
// family invariant, which the transaction itself (via
// productOfferingRepository.activateOffering) re-checks with a row lock.
export async function activateOffering(
  offeringId: string,
  input: ActivateOfferingInput,
  actorId: string,
): Promise<ActivateOfferingResult> {
  const offering = await productOfferingRepository.findDetailById(
    db,
    offeringId,
  );
  if (!offering) {
    return { ok: false, code: "OFFERING_NOT_FOUND" };
  }
  if (offering.lifecycleStatus !== "DRAFT") {
    return { ok: false, code: "OFFERING_NOT_DRAFT" };
  }

  const prices = await productOfferingPriceRepository.findByOfferingIdWithDerivedEnd(
    db,
    offeringId,
  );
  if (prices.length === 0) {
    return { ok: false, code: "NO_PRICE_ROWS" };
  }

  // Decision 5's literal rule: at least one specification exists, AND every
  // mandatory one has a resolved (non-null) defaultValue (Design).
  const specs = await productSpecificationRepository.findByOfferingId(
    db,
    offeringId,
  );
  const specificationsResolved =
    specs.length > 0 &&
    specs.every((spec) => !spec.isMandatory || spec.defaultValue !== null);
  if (!specificationsResolved) {
    return { ok: false, code: "SPECIFICATIONS_NOT_RESOLVED" };
  }

  const transitionReason = input.reason || null;

  return db.transaction(async (tx) => {
    const { offeringId: activatedId, supersededOfferingId } =
      await productOfferingRepository.activateOffering(tx, offeringId);

    if (supersededOfferingId) {
      await insertAuditEvent(tx, {
        eventType: "PRODUCT_OFFERING_SUPERSEDED",
        actorUserId: actorId,
        targetEntity: "PRODUCT_OFFERING",
        targetId: supersededOfferingId,
        beforeData: { lifecycleStatus: "ACTIVE" },
        afterData: {
          lifecycleStatus: "RETIRED",
          supersededByOfferingId: activatedId,
        },
      });
    }

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_ACTIVATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: activatedId,
      beforeData: { lifecycleStatus: "DRAFT" },
      afterData: {
        lifecycleStatus: "ACTIVE",
        transitionReason,
      },
    });

    return {
      ok: true,
      offeringId: activatedId,
      supersededOfferingId,
    };
  });
}
```

`transitionReason` uses `input.reason || null` (not `??`) specifically so a submitted-but-empty string (`""` — a valid, non-`.min(1)`-constrained value per §3.1) collapses to the same `null` as an omitted key, rather than persisting an empty string into the audit payload as if it were a meaningfully distinct value from "no reason given." `PRODUCT_OFFERING_SUPERSEDED`'s payload carries no `transitionReason` key at all (Design) — only `PRODUCT_OFFERING_ACTIVATED`'s does. `targetEntity: "PRODUCT_OFFERING"` matches every prior offering-scoped event's convention (pm11/pm13).

### 3.6 Service — `services/product/retire-offering.ts` (new)

```ts
import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { RetireOfferingInput } from "@/validation/product/retire-offering.schema";

export type RetireOfferingResult =
  | {
      ok: true;
      offeringId: string;
      eventType: "PRODUCT_OFFERING_RETIRED" | "PRODUCT_OFFERING_DISCARDED";
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" };

// pm16-spec §3.6. One repository call, two possible audit event types,
// chosen from the offering's status as read before the transaction opens
// (Design; code-standards-phase2 §1 rule 11) — "Retire" for a source that
// was ACTIVE, "Discard" for a source that was DRAFT.
export async function retireOffering(
  offeringId: string,
  input: RetireOfferingInput,
  actorId: string,
): Promise<RetireOfferingResult> {
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

  const eventType =
    offering.lifecycleStatus === "ACTIVE"
      ? "PRODUCT_OFFERING_RETIRED"
      : "PRODUCT_OFFERING_DISCARDED";
  const transitionReason = input.reason || null;

  return db.transaction(async (tx) => {
    const { offeringId: retiredId } =
      await productOfferingRepository.retireOffering(tx, offeringId);

    await insertAuditEvent(tx, {
      eventType,
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: retiredId,
      beforeData: { lifecycleStatus: offering.lifecycleStatus },
      afterData: {
        lifecycleStatus: "RETIRED",
        transitionReason,
      },
    });

    return { ok: true, offeringId: retiredId, eventType };
  });
}
```

Same `input.reason || null` collapsing as `activate-offering.ts` (§3.5). `eventType` is computed once, ahead of the transaction, from the same `findDetailById` read that already produced the not-found/already-retired checks — no second read needed, mirroring pm13/14/15's "no new repository read method, reuse what's already been fetched" precedent.

### 3.7 Guardrail test — `tests/guardrails/product-module-boundaries.test.ts` (edit — extend `PRODUCT_WRITE_SERVICE_FILES` only)

```ts
const PRODUCT_WRITE_SERVICE_FILES = new Set([
  "create-offering.ts",
  // "update-offering.ts", "add-specification.ts", "update-specification.ts",
  // "delete-specification.ts", "insert-price.ts" — present here already if
  // pm13/pm14/pm15 landed first; do not remove any of them if so.
  "activate-offering.ts",
  "retire-offering.ts",
]);
```

Same reasoning every prior unit's own §3.8/§3.5 gave: `activate-offering.ts` and `retire-offering.ts` both legitimately import `insertAuditEvent` (Design), so without this edit the "no product read path imports the audit-log write path" guardrail would start failing the moment these two service files exist. Strictly additive — one `Set` literal gains two more entries, no other line in the test file changes.

### 3.8 No schema change, no Server Action, no UI in this unit

`db/schema/product.ts` is untouched — this unit writes existing columns only, on a table pm10/pm11 already shipped. `actions/product/activate-offering.action.ts`, `retire-offering.action.ts`, and `components/products/manage/retire-offering-dialog.tsx` all belong to pm23. Per the build plan's boundary line and dependency graph, no file under `actions/`, `components/`, or `app/` changes in this unit.

## 4. Dependencies

**No new npm packages.** Zod, Drizzle (`^0.45.2`, already providing `.for("update")` — see Design), and the Postgres driver are already installed and already used by every existing validation schema, repository, and write service in this codebase. **No DB extensions, no migration.**

## 5. Verify when done

**Diff hygiene**
- [ ] `git status` shows only: `validation/product/activate-offering.schema.ts` (new), `validation/product/retire-offering.schema.ts` (new), `db/repositories/product-offering.ts` (three new methods added: `findActiveInFamily`, `activateOffering`, `retireOffering`; `findList`/`findDetailById`/`insertOffering`/`branchOfferingAsDraft`/`updateOfferingDraftInPlace` [if present] untouched), `types/audit.ts` (exactly four new array entries, appended last), `services/product/activate-offering.ts` (new), `services/product/retire-offering.ts` (new), `tests/guardrails/product-module-boundaries.test.ts` (one `Set` literal extended by exactly two entries). No `actions/`, `components/`, `app/`, or `db/schema/` changes.
- [ ] Neither new repository method takes an `actorId`/`actor`-shaped parameter — attribution stays entirely in the two service files.

**Backend correctness — activation, direct success path**
- [ ] Seed a `DRAFT` offering, add one specification via the real `addSpecification` service with `isMandatory: true` and a non-null `defaultValue` (pm14), add one price via the real `insertPrice` service (pm15) — per the build plan's own instruction to populate fixtures through the real services, not raw SQL. Calling `activateOffering(draftId, {}, actorId)` returns `{ ok: true, offeringId: draftId, supersededOfferingId: null }` and the row's `lifecycle_status` is now `'ACTIVE'` in the DB.
- [ ] Exactly one audit row appears: `event_type = 'PRODUCT_OFFERING_ACTIVATED'`, `target_id = draftId`, `before_data = { lifecycleStatus: "DRAFT" }`, `after_data = { lifecycleStatus: "ACTIVE", transitionReason: null }`. No `PRODUCT_OFFERING_SUPERSEDED` row appears (no prior active sibling existed).
- [ ] Calling with `{ reason: "Q3 rate refresh" }` produces `after_data.transitionReason === "Q3 rate refresh"`; calling with `{ reason: "" }` produces `after_data.transitionReason === null` (empty string collapses to `null`, Design).

**Backend correctness — activation preconditions rejected**
- [ ] A `DRAFT` with zero price rows (regardless of specification state) returns `{ ok: false, code: "NO_PRICE_ROWS" }`, performs no `UPDATE` on `product_offering`, and writes no audit row.
- [ ] A `DRAFT` with at least one price but zero specification rows returns `{ ok: false, code: "SPECIFICATIONS_NOT_RESOLVED" }`.
- [ ] A `DRAFT` with at least one price and at least one specification, but at least one `isMandatory: true` specification whose `defaultValue` is `null`, returns `{ ok: false, code: "SPECIFICATIONS_NOT_RESOLVED" }` — even when other, non-mandatory specifications are fully resolved.
- [ ] A `DRAFT` with at least one price and every specification resolved, but including at least one non-mandatory specification with a `null` `defaultValue`, still succeeds — an unresolved *non-mandatory* specification never blocks activation.
- [ ] Both rejection cases leave the offering's `lifecycle_status` as `'DRAFT'` and write no audit row.

**Backend correctness — not-found and not-DRAFT guards**
- [ ] `activateOffering` against a nonexistent `offeringId` returns `{ ok: false, code: "OFFERING_NOT_FOUND" }`.
- [ ] `activateOffering` against an already-`ACTIVE` offering returns `{ ok: false, code: "OFFERING_NOT_DRAFT" }`, regardless of its own price/spec state.
- [ ] `activateOffering` against a `RETIRED` offering returns `{ ok: false, code: "OFFERING_NOT_DRAFT" }`.
- [ ] All three guard cases call neither `productOfferingRepository.activateOffering` nor `productOfferingRepository.findActiveInFamily`, and write no audit row.

**Backend correctness — automatic supersession (single activation)**
- [ ] Starting from a family with an existing `ACTIVE` row `V1` and a `DRAFT` sibling `V2` that meets both preconditions, calling `activateOffering(v2Id, {}, actorId)` flips `V2` to `ACTIVE` **and**, in the same call, flips `V1` to `RETIRED` — re-fetch both rows afterward and confirm.
- [ ] The result is `{ ok: true, offeringId: v2Id, supersededOfferingId: v1Id }`.
- [ ] Two audit rows appear, in this order: `event_type = 'PRODUCT_OFFERING_SUPERSEDED'` with `target_id = v1Id`, `before_data = { lifecycleStatus: "ACTIVE" }`, `after_data = { lifecycleStatus: "RETIRED", supersededByOfferingId: v2Id }` (no `transitionReason` key on this row); then `event_type = 'PRODUCT_OFFERING_ACTIVATED'` with `target_id = v2Id`.
- [ ] A family with no existing `ACTIVE` member at all (e.g. two sibling `DRAFT`s, neither yet activated) produces `supersededOfferingId: null` on the first one activated, and no `PRODUCT_OFFERING_SUPERSEDED` row.

**Backend correctness — Inv. 13 under real concurrency (the build plan's own required proof)**
- [ ] Seed a family with three members meeting activation preconditions: `V1` (`ACTIVE`), `V2` and `V3` (both `DRAFT`). Fire `Promise.all([activateOffering(v2Id, {}, actorId), activateOffering(v3Id, {}, actorId)])` against the real test database (true concurrent connections, not a mocked/sequential test double). Both calls resolve `{ ok: true, ... }`. Re-fetch all three rows afterward: **exactly one** of `{V1, V2, V3}` is `ACTIVE`, the other two are `RETIRED` — never zero, never two (code-standards-phase2 §9 guardrail 8, verified directly, not just asserted by construction).
- [ ] Whichever of `V2`/`V3` ends up `RETIRED` (as opposed to the original `V1`, which is retired in every run) has exactly one `PRODUCT_OFFERING_SUPERSEDED` audit row pointing at whichever offering ultimately stayed `ACTIVE` — confirms the audit trail stays internally consistent even under the interleaved-commit ordering this test exercises, not just the single-caller case above.
- [ ] Repeating this test a handful of times (interleaving/commit order is not fully deterministic) never once produces two simultaneously `ACTIVE` rows in the family.

**Backend correctness — retire (source ACTIVE)**
- [ ] Calling `retireOffering(activeId, {}, actorId)` against an `ACTIVE` offering flips it to `RETIRED` and returns `{ ok: true, offeringId: activeId, eventType: "PRODUCT_OFFERING_RETIRED" }`.
- [ ] Exactly one audit row appears: `event_type = 'PRODUCT_OFFERING_RETIRED'`, `target_id = activeId`, `before_data = { lifecycleStatus: "ACTIVE" }`, `after_data = { lifecycleStatus: "RETIRED", transitionReason: null }` (or the supplied reason string, when given).

**Backend correctness — discard (source DRAFT)**
- [ ] Calling `retireOffering(draftId, {}, actorId)` against a `DRAFT` offering flips it to `RETIRED` and returns `{ ok: true, offeringId: draftId, eventType: "PRODUCT_OFFERING_DISCARDED" }`.
- [ ] Exactly one audit row appears: `event_type = 'PRODUCT_OFFERING_DISCARDED'`, `target_id = draftId`, `before_data = { lifecycleStatus: "DRAFT" }`, `after_data = { lifecycleStatus: "RETIRED", transitionReason: null }` (or the supplied reason string).
- [ ] The same repository method (`productOfferingRepository.retireOffering`) is the one called in both the ACTIVE-source and DRAFT-source cases — confirmed by source inspection, not just behaviorally — satisfying "one repository call, different audit events" (code-standards-phase2 §1 rule 11).

**Backend correctness — retire/discard guards**
- [ ] `retireOffering` against a nonexistent `offeringId` returns `{ ok: false, code: "OFFERING_NOT_FOUND" }` and writes nothing.
- [ ] `retireOffering` against an already-`RETIRED` offering returns `{ ok: false, code: "OFFERING_RETIRED" }`, calls `productOfferingRepository.retireOffering` zero times, and writes no audit row — confirming `RETIRED` is terminal (no re-retire, no un-discard).

**Boundary**
- [ ] `services/product/activate-offering.ts` and `services/product/retire-offering.ts` contain no `next/*` import, no `"use server"` directive.
- [ ] `db/repositories/product-offering.ts` contains no import of `@/db/repositories/audit.repository`, no reference to `insertAuditEvent` or `AUDIT_LOG` — the guardrail's "no product read path imports the audit-log write path" check continues to pass for this file (repositories never audit).
- [ ] No `actions/product/` directory or file exists yet as a result of this unit (that's pm23).
- [ ] `findActiveInFamily`'s `.for("update")` call is present in source (grep) — confirms the locking mechanism Design relies on wasn't silently dropped during implementation.

**Build gates**
- [ ] `npm run typecheck` green — `ActivateOfferingInput`, `RetireOfferingInput`, `ActivateOfferingResult`, `RetireOfferingResult`, and all three new repository methods' parameter/return types resolve with no manual `any`.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] Existing Phase 1, pm11, pm12, pm13 (if landed), pm14, and pm15 tests still pass unmodified — this unit adds two schemas, three repository methods, two service files, one audit-type extension (four entries), and one guardrail `Set` extension; it touches no existing method's behavior or signature.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy, not the plan-folder mirror) gets a pm16 entry with the commit reference, once this actually ships.

Any failing item means the unit is not done. Unit pm18 (Manage Products page shell) depends on real `DRAFT`/`ACTIVE`/`RETIRED` rows existing to display, which this unit (alongside pm11–pm15) is what produces them. Unit pm23 (Lifecycle actions UI) depends on `activateOffering`'s and `retireOffering`'s exact result shapes — including `supersededOfferingId` and `eventType` — existing and verified; do not start it until every item above passes. Unit pm24 (ship gate) depends on this unit's guardrail-8 behavior holding under its own dedicated concurrency test, not just this unit's own — re-run this spec's concurrency test as part of pm24's full sweep, not only once here.
