# PM12 — Backend: Branch-as-draft primitive

- **Unit:** 12 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm11 (`insertOffering` shipped and verified — establishes the "root has null `family_offering_id`, `is_bundle` never user-set" conventions this primitive must preserve when cloning).
- **Authorizing sections:** `prodmgmt-architecture-phase2.md` §3 (Storage Model — family resolution is always one hop, `version` = row's sequence number within its family computed as `MAX(version)` across the resolved family + 1, `is_bundle` "never user-settable, only copied through unchanged when a row is cloned"), §6 Inv. 14 (editing an `ACTIVE` offering never mutates it in place — cloning the offering *plus all of its specifications and all of its prices* is the mechanism); `prodmgmt-code-standards-phase2.md` §1 rule 9 (`is_bundle` never user-editable — "`branchOfferingAsDraft` copies whatever value the source row already has... no code path lets a user set it"), §6 rule 12 (a write against an `ACTIVE` offering always lands on a freshly branched `DRAFT`); `pm99-build-plan-phase2.md` Unit pm12 (this unit's literal contract); `pm11-spec.md` (the `insertOffering` shape and the "repositories never audit" convention this unit continues).
- **Codebase state assumed at start (re-verify before implementing):** Unit pm11 shipped — `db/repositories/product-offering.ts` exports `findList`, `findDetailById`, and `insertOffering` (the third hardcodes `isBundle: false`, `familyOfferingId: null`, `lifecycleStatus: "DRAFT"`, `version: 1`). `types/audit.ts`'s `AUDIT_EVENT_TYPES` ends at `"PRODUCT_OFFERING_CREATED"`. `services/product/create-offering.ts` exists as the module's first write service. No `updateOfferingDraftInPlace`, `branchOfferingAsDraft`, `activateOffering`, or `findActiveInFamily` exist yet anywhere in `db/repositories/product-offering.ts`. `db/repositories/product-specification.ts` exports only `findByOfferingId`; `db/repositories/product-offering-price.ts` exports only `findByOfferingIdWithDerivedEnd` — neither gains anything in this unit (this unit *reads* both tables directly from `product-offering.ts` via the shared schema imports, it does not add methods to either sibling repository file).

---

## 1. Goal

Give every later mutation unit (pm13 update, pm14 specs, pm15 prices, pm16 activate/retire) one shared, transaction-composable primitive — `branchOfferingAsDraft(tx, sourceOfferingId, overrides?)` — that clones a source offering plus all of its specification and price rows into a brand-new `DRAFT` row correctly positioned in the source's version family, so none of those units has to re-derive family resolution, version numbering, or child-row cloning on its own.

## 2. Design

**Why this lives in `db/repositories/product-offering.ts` and not a new file:** the build plan's boundary line is explicit — "Backend data-access layer (`db/repositories/product-offering.ts` only)." Even though the function reads rows out of `product_specifications` and `product_offering_price`, it does so via the schema objects already imported by other repository files (`productSpecifications`, `productOfferingPrice` from `@/db/schema/product`), not by adding methods to `product-specification.ts` or `product-offering-price.ts`. Those two files stay exactly as pm11 left them.

**Why `overrides` is typed with no `isBundle` key, the same two-layer defense pm11 used for `insertOffering`:** `create-offering.schema.ts` never defines an `isBundle` field, and `insertOffering`'s parameter type has no `isBundle` key either — the schema can't parse it in, and the repository can't read it out. This unit continues that discipline for the second, independent path a stray `isBundle` value could otherwise enter through: `BranchOfferingOverrides` (defined below, §3.1) has `name?`, `isSellable?`, `billingOnly?` and nothing else. The insert call site then sources `isBundle` from `source.isBundle` unconditionally — never from `overrides`, not even if a caller bypasses the type system with an `as any` cast, because there is no branch of the code that ever reads an `isBundle` key off `overrides` in the first place. This matches the build plan's literal wording: "`isBundle` copied unconditionally, never from overrides."

**Why the other three fields use `overrides?.field ?? source.field` instead of an object spread:** `overrides` is `Partial`-shaped and every field is independently optional. `{ ...source, ...overrides }` would work for a plain spread today, but explicit `??` per field is preferred here for two reasons: it stays correct if a future caller ever needed to distinguish "explicitly pass `false`" from "omit the key" for a boolean field (`??` only falls through on `null`/`undefined`, never on `false`, so `overrides: { isSellable: false }` correctly overrides even though `false` is falsy), and it keeps the "which three fields are overridable" list visible at the call site rather than implicit in whatever keys `source` happens to have.

**Family resolution is inlined, not extracted into a shared exported helper — yet.** `const rootId = source.familyOfferingId ?? source.productOfferingId` is the one-hop resolution `prodmgmt-architecture-phase2.md` §3 describes ("a non-null value points directly at the root's id — always one hop, even for a branch-of-a-branch"). Unit pm16 will need the same one-liner inside `activateOffering` before it calls `findActiveInFamily(tx, resolvedRootId)`. This unit does not speculatively factor that out into a shared exported `resolveFamilyRootId` — it is a single expression, duplicating it once in pm16 costs less than a shared abstraction whose shape hasn't been needed twice yet. If a third caller needs it, that caller's unit is the right place to extract it.

**Version numbering runs a `MAX(version)` query scoped to the resolved family, not a running counter anywhere.** This mirrors `prodmgmt-code-standards-phase2.md` §6 rule (v1 6.7 superseded): "`version` is now a row's sequence number within its version family... computed as `MAX(version)` across the resolved family + 1." The query is `WHERE product_offering_id = :rootId OR family_offering_id = :rootId` — the exact predicate `prodmgmt-architecture-phase2.md` §3 names for "all versions of this product."

**Why this unit does not add an in-transaction re-check the way `activateOffering` (Inv. 13) will:** Inv. 13's re-check exists because two concurrent activations racing for "the one `ACTIVE` slot in a family" is a correctness-critical invariant (at most one `ACTIVE` row, ever). Two concurrent branches of the same family computing the same `MAX(version) + 1` and both inserting, say, `version = 2`, is not correctness-critical in the same way — nothing downstream treats `version` as a uniqueness key (there is no unique index on `(family_offering_id, version)`), it is a display/ordering aid. This is a deliberate, disclosed gap, not an oversight: closing it would mean either a `SELECT ... FOR UPDATE` on the family's rows or a real DB constraint, and nothing in `pm99-build-plan-phase2.md` or the architecture addendum asks for that here. Flagging it so it isn't mistaken for an omission if it comes up in review.

**Why `lastModified` and `lastEditedBy` are *not* copied from the source row:** the branched row is a new row coming into existence now, not a historical replay of the source's own metadata. This mirrors `insertOffering`'s own precedent exactly (pm11-spec.md §3.2: "`lastModified` defaults to `now()`; `lastEditedBy` stays `NULL`... no existing repository method sets it either"). Neither field is passed in the insert `.values()` call, so both fall through to their column defaults/nullability — `lastModified` becomes "now," `lastEditedBy` stays `NULL` until whichever later unit's service stamps an editor.

**Why cloned price rows *do* copy `created_at` from the source, unlike the offering row's `lastModified`:** the build plan's visible result is explicit that the cloned specification and price rows must be "byte-identical in content to the source's but with new ids." "Content" here is read literally — every column except the row's own PK and the FK back to its parent offering — which includes `created_at`. This is a different judgment call from the offering row's `lastModified` above precisely because the build plan draws that line for children but not for the offering row itself: the offering's own top-level fields (`lastModified`) are metadata about the offering row, while a price row's `created_at` is itself part of the row's immutable forensic content (Inv. 1, "price rows immutable... price-history-as-forensics-source," unchanged by Phase 2). Preserving it keeps the clone a faithful copy of that forensic record rather than silently rewriting when-created history for rows that, content-wise, didn't just get created — they got copied.

**No audit write in this unit — repositories never audit, full stop.** `pm99-build-plan-phase2.md`'s own text: "No audit write here — audit belongs to whichever service triggers the branch (Units pm13–pm15)." This is also mechanically enforced today: `tests/guardrails/product-module-boundaries.test.ts`'s existing "no product read path imports the audit-log write path" check scans every `db/repositories/product-*.ts` file unconditionally (not just read-only ones) for `audit.repository` / `insertAuditEvent` / `AUDIT_LOG` substrings and fails if any appear. `branchOfferingAsDraft` must not import `@/db/repositories/audit.repository`, and does not need to — it has no `actorId` parameter at all, by design (see build plan's literal signature: `branchOfferingAsDraft(tx, sourceOfferingId, overrides?)`), because attributing the branch to an actor is the calling service's job, not this primitive's.

**Why the primitive is not itself wrapped in `db.transaction(...)`:** its signature takes `tx: Database` (the same union type `insertOffering`/`insertRole` accept — either the pooled `db` handle or an already-open transaction), meaning the *caller* decides transaction scope. `pm13`–`pm16`'s services will call `db.transaction(async (tx) => { const { offeringId } = await productOfferingRepository.branchOfferingAsDraft(tx, sourceId, overrides); await insertAuditEvent(tx, {...}); ... })`, so the clone and its audit row commit or roll back together. This unit's own integration test may call it with the bare `db` handle directly (both satisfy the `Database` type) since the test only needs to observe the primitive's own output, not compose it with anything else.

**No visual/UI design in this unit** — backend data-access layer only, per the build plan's boundary. No service wrapper, no Server Action, no form, no page, no new audit event type. Those arrive with pm13–pm16 (each of which calls this primitive and adds its own `PRODUCT_OFFERING_BRANCHED`-family audit entry from its own service file).

## 3. Implementation

### 3.1 Repository — `db/repositories/product-offering.ts` (edit — add `BranchOfferingOverrides` type and `branchOfferingAsDraft`)

Add two new imports at the top (schema tables for the child rows this unit reads/clones, plus two `drizzle-orm` helpers not currently imported):

```ts
import { and, asc, count, desc, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";

import type { Database } from "@/db/client";
import { appuser } from "@/db/schema/identity";
import {
  productOffering,
  productOfferingPrice,
  productSpecifications,
} from "@/db/schema/product";
import type { LifecycleStatus, OfferingListRow } from "@/types/product";
import type { OFFERING_SORT_VALUES } from "@/validation/product/offering-list.schema";
```

New exported type, placed alongside the existing `OfferingSort`/`OfferingListFilters` exports (before the `productOfferingRepository` object):

```ts
// The only three offering fields a branch may override — deliberately has
// no `isBundle` key (Design). pm13's `updateOfferingDraftInPlace` input
// shares this same field set minus `saveAsNew`, which is a service-level
// routing flag, not an offering column.
export interface BranchOfferingOverrides {
  name?: string;
  isSellable?: boolean;
  billingOnly?: boolean;
}
```

New private helper, placed above the `productOfferingRepository` export (same file, not exported — internal to this module only):

```ts
// `prodmgmt-architecture-phase2.md` §3: version = MAX(version) across the
// resolved family + 1. `rootId` must already be resolved (one hop) by the
// caller — this helper does not itself chase `family_offering_id`.
async function resolveNextVersion(
  tx: Database,
  rootId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      maxVersion: sql<number | null>`max(${productOffering.version})`,
    })
    .from(productOffering)
    .where(
      or(
        eq(productOffering.productOfferingId, rootId),
        eq(productOffering.familyOfferingId, rootId),
      ),
    );
  return (row?.maxVersion ?? 0) + 1;
}
```

New method, added to the existing `productOfferingRepository` object (alongside `findList` / `findDetailById` / pm11's `insertOffering`):

```ts
// pm12-spec §3.1. Clones `sourceOfferingId` plus every one of its
// specification and price rows into a new DRAFT row in the same version
// family. No audit write (Design) — the caller composes this inside its
// own `db.transaction` alongside its own audit entry.
async branchOfferingAsDraft(
  tx: Database,
  sourceOfferingId: string,
  overrides?: BranchOfferingOverrides,
): Promise<{ offeringId: string }> {
  const [source] = await tx
    .select()
    .from(productOffering)
    .where(eq(productOffering.productOfferingId, sourceOfferingId))
    .limit(1);
  if (!source) {
    throw new Error(
      `branchOfferingAsDraft: source offering ${sourceOfferingId} not found`,
    );
  }

  // One-hop family resolution (architecture-phase2 §3): NULL means the
  // source itself is the root.
  const rootId = source.familyOfferingId ?? source.productOfferingId;
  const nextVersion = await resolveNextVersion(tx, rootId);

  const [branched] = await tx
    .insert(productOffering)
    .values({
      name: overrides?.name ?? source.name,
      // Copied unconditionally — never sourced from `overrides`, which has
      // no `isBundle` key to read in the first place (Design).
      isBundle: source.isBundle,
      isSellable: overrides?.isSellable ?? source.isSellable,
      billingOnly: overrides?.billingOnly ?? source.billingOnly,
      lifecycleStatus: "DRAFT",
      version: nextVersion,
      familyOfferingId: rootId,
      // lastModified / lastEditedBy intentionally omitted — fall through to
      // column defaults, matching insertOffering's precedent (Design).
    })
    .returning({ offeringId: productOffering.productOfferingId });
  if (!branched) {
    throw new Error("branchOfferingAsDraft: insert returned no row");
  }
  const offeringId = branched.offeringId;

  const sourceSpecs = await tx
    .select()
    .from(productSpecifications)
    .where(eq(productSpecifications.refProductOfferingId, sourceOfferingId));
  if (sourceSpecs.length > 0) {
    await tx.insert(productSpecifications).values(
      sourceSpecs.map((spec) => ({
        refProductOfferingId: offeringId,
        name: spec.name,
        isMandatory: spec.isMandatory,
        isDefault: spec.isDefault,
        defaultValue: spec.defaultValue,
        productSpecCharacteristics: spec.productSpecCharacteristics,
      })),
    );
  }

  const sourcePrices = await tx
    .select()
    .from(productOfferingPrice)
    .where(eq(productOfferingPrice.productOfferingId, sourceOfferingId));
  if (sourcePrices.length > 0) {
    await tx.insert(productOfferingPrice).values(
      sourcePrices.map((price) => ({
        productOfferingId: offeringId,
        name: price.name,
        priceType: price.priceType,
        recurringChargePeriodLength: price.recurringChargePeriodLength,
        recurringChargePeriodType: price.recurringChargePeriodType,
        unitOfMeasure: price.unitOfMeasure,
        amount: price.amount,
        currency: price.currency,
        glCode: price.glCode,
        pricingModel: price.pricingModel,
        policy: price.policy,
        pricingCharacteristics: price.pricingCharacteristics,
        startDateTime: price.startDateTime,
        // Copied, not defaulted — "byte-identical in content" (Design).
        createdAt: price.createdAt,
      })),
    );
  }

  return { offeringId };
},
```

Note `productSpecId` and `productOfferingPriceId` are absent from both `.values()` maps, the same way `productOfferingId` is absent from `insertOffering`'s — each falls through to its `PRD…` sequence-backed column default, guaranteeing the "fresh PKs" the build plan requires without this code ever touching a sequence directly.

### 3.2 No schema change, no audit event type, no service, no Server Action, no UI in this unit

`db/schema/product.ts` is untouched — this unit reads existing columns only, on tables pm10 and pm11 already shipped. `types/audit.ts` gains nothing here; `PRODUCT_OFFERING_BRANCHED` is added by whichever of pm13–pm15 first needs it. Per the build plan's boundary line ("Backend data-access layer (`db/repositories/product-offering.ts` only)") and dependency graph, no file under `services/product/`, `actions/product/`, `components/`, or `app/` changes in this unit — those arrive with pm13 (first consumer of this primitive) onward.

## 4. Dependencies

**No new npm packages.** Drizzle and the Postgres driver are already installed and already used by every existing method in `db/repositories/product-offering.ts`; `or` and `sql` are both already-available exports of the `drizzle-orm` package this file already imports from — this unit only adds them to the existing import statement. **No DB extensions, no migration.**

## 5. Verify when done

**Diff hygiene**
- [ ] `git status` shows exactly one changed file: `db/repositories/product-offering.ts` (`BranchOfferingOverrides` type added, `resolveNextVersion` private helper added, `branchOfferingAsDraft` method added; `findList`, `findDetailById`, and pm11's `insertOffering` untouched). No changes anywhere under `services/`, `actions/`, `components/`, `app/`, `db/schema/`, `db/migrations/`, or `types/audit.ts`.
- [ ] `branchOfferingAsDraft`'s `overrides` parameter type (`BranchOfferingOverrides`) has no `isBundle` key, structurally — grep confirms no code path in this diff reads an `isBundle`/`is_bundle` value off `overrides` before the `source.isBundle` literal at the insert call site.

**Backend correctness — family resolution & version**
- [ ] Branching a root offering (`family_offering_id IS NULL`, `version = 1`) produces a new row with `family_offering_id` equal to the *source's own* `product_offering_id`, and `version = 2`.
- [ ] Branching a non-root offering (itself already `family_offering_id = rootId`, `version = 2`) produces a new row with `family_offering_id = rootId` (the same root — one hop, not pointing at the version-2 row) and `version = 3` — proves branch-of-a-branch resolves in one hop, not by chasing the chain.
- [ ] `lifecycle_status` on the new row is always `'DRAFT'`, regardless of the source's own status (test against both an `ACTIVE` and a `DRAFT` source).

**Backend correctness — field copying & overrides**
- [ ] Calling with no `overrides` argument produces a new row whose `name`/`is_sellable`/`billing_only` exactly match the source's.
- [ ] Calling with `overrides: { name: "New Name" }` changes only `name` on the new row; `is_sellable`/`billing_only` still match the source.
- [ ] Calling with `overrides: { isSellable: false }` on a source where `is_sellable = true` correctly produces `is_sellable = false` on the clone — confirms `??` (not a truthy check) is used, since `false` must not be treated as "no override given."
- [ ] `is_bundle` on the clone always equals the source's `is_bundle`, tested against a source row with `is_bundle = true` (inserted directly via test fixture, since no production insert path can produce `true` yet) — proves the value survives cloning even when non-default.
- [ ] Passing a crafted `overrides` object with an extra `isBundle: true` key (bypassing the type system via `as any` in a test) still produces the clone's `is_bundle` equal to the *source's* `is_bundle`, not `true` — proves the guarantee holds even against a malformed caller, not just a well-typed one.

**Backend correctness — child-row cloning**
- [ ] Branching an offering with 2 specification rows and 4 price rows (mirroring the seed's "5G Nationwide Service Plan" shape, per the build plan) produces exactly 2 new specification rows and 4 new price rows, each with a freshly generated id distinct from every source row's id.
- [ ] Every cloned specification row's `name`, `is_mandatory`, `is_default`, `default_value`, and `product_spec_characteristics` exactly match its corresponding source row; every cloned price row's `name`, `price_type`, `recurring_charge_period_length`, `recurring_charge_period_type`, `unit_of_measure`, `amount`, `currency`, `gl_code`, `pricing_model`, `policy`, `pricing_characteristics`, `start_date_time`, and `created_at` exactly match its corresponding source row — "byte-identical in content... but with new ids," per field.
- [ ] Every cloned specification row's `ref_product_offering_id` and every cloned price row's `product_offering_id` point at the *new* offering id, not the source's.
- [ ] Branching a source with zero specification rows or zero price rows succeeds without error and leaves the corresponding table with no new rows for that offering (the `length > 0` guards are exercised, not just the non-empty path).

**Backend correctness — source untouched**
- [ ] After branching, the source offering row is unchanged in every column (re-fetch by id and compare against a pre-branch snapshot).
- [ ] After branching, every one of the source's original specification and price rows still exists, unchanged, still pointing at the source's own id — cloning must not reparent or mutate anything belonging to the source.

**Boundary**
- [ ] `db/repositories/product-offering.ts` contains no import of `@/db/repositories/audit.repository`, no reference to `insertAuditEvent`, and no reference to `AUDIT_LOG` — `tests/guardrails/product-module-boundaries.test.ts`'s existing "no product read path imports the audit-log write path" check (which scans every `product-*.ts` repository file unconditionally) continues to pass unmodified.
- [ ] `branchOfferingAsDraft` has no `actorId`/`actor`-shaped parameter — attribution is out of scope for this primitive by construction.
- [ ] No `services/product/`, `actions/product/`, or `components/products/manage/` file exists as a result of this unit.

**Build gates**
- [ ] `npm run typecheck` green — `BranchOfferingOverrides`, `branchOfferingAsDraft`'s parameter/return types, and `resolveNextVersion`'s return type all resolve with no manual `any`.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] Existing Phase 1 and pm11 tests still pass unmodified — this unit adds one type, one private helper, and one repository method; it touches no existing method's behavior or signature.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy, not the plan-folder mirror) gets a pm12 entry with the commit reference, once this actually ships.

Any failing item means the unit is not done. Units pm13 (update), pm14 (specifications), pm15 (prices), and pm16 (activation preconditions) all depend on `branchOfferingAsDraft`'s exact behavior existing and verified — do not start any of them until every item above passes.
