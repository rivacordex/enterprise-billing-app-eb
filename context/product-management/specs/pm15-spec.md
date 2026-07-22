# PM15 — Backend: Price management

- **Unit:** 15 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm12 (`branchOfferingAsDraft` shipped and verified — this unit's `ACTIVE`-target path calls it directly, with no `overrides`). Not dependent on pm13 or pm14 — pm13 (update offering), pm14 (specifications), and pm15 (this unit) all branch from pm12 independently per the dependency graph and may land in any order relative to each other.
- **Authorizing sections:** `prodmgmt-project-overview-phase2.md` "Price management" ("Add price: name, price type, pricing model (flat or tiered), currency, GL code, start date. On an `ACTIVE` offering, this triggers the clone-to-new-draft behavior; on a `DRAFT`, it applies directly... Prices remain insert-only everywhere... A new price's start date may be backdated up to 3 days; the form shows a non-blocking warning when it is. Earlier than that is rejected outright.") and Success Criteria ("There is no UI control, server action, or repository method anywhere in the codebase that updates or deletes an existing price row, confirmed by the guardrail test that inspects the price repository's exported method names"); `prodmgmt-architecture-phase2.md` §3 (Prices row nuance — an `ACTIVE`-target price add lands on a brand-new branched `DRAFT` with its own freshly assigned `version`, the original `ACTIVE` row untouched; backdating tolerance resolved to "up to 3 days in the past, non-blocking warning; beyond that, rejected") and §6 Inv. 2 amendment (the same backdating rule) and Inv. 14 (editing an `ACTIVE` offering's prices never mutates them in place — routes through `branchOfferingAsDraft` first); `prodmgmt-code-standards-phase2.md` §1 rule 12 ("Backdating tolerance is a service-layer check, not a DB constraint... rejects a `start_date_time` more than 3 days in the past (`BACKDATED_START_TOO_FAR`) and flags (non-blocking) anything backdated within that window") and §6 rule 14 ("enforced in `insert-price.ts` (the write service), checked against the transaction's `now()`... not in the Zod schema alone") and §9 guardrail 14 ("Price immutability, now behaviorally testable — inserting a successor price leaves the old row untouched and (when the target was already `DRAFT`) the offering's `version` is whatever it already was"); `pm99-build-plan-phase2.md` Unit pm15 (this unit's literal contract); `pm12-spec.md` (`branchOfferingAsDraft`'s exact signature, clone-content guarantees, and "repositories never audit" convention); `pm14-spec.md` (the branch-first-on-create routing shape this unit's own create-only path mirrors, and its `OFFERING_RETIRED` defensive guard); `pm03-spec.md` §3.4/§3.6 (the "Phase 1 finder file," `db/repositories/product-offering-price.ts`, `pricing-characteristics.schema.ts`'s XOR discriminated union, and `PriceCard`'s shape); `services/product/get-offering-detail.ts` (the `now: Date = new Date()` injectable-clock convention this unit's service reuses for deterministic tests).
- **Codebase state assumed at start (re-verify before implementing):** Unit pm11 is shipped — `db/repositories/product-offering.ts` exports `findList`, `findDetailById`, `insertOffering`. **Unit pm12 is not yet shipped as of this writing** — `branchOfferingAsDraft` does not exist anywhere in `db/repositories/product-offering.ts`. Do not begin this unit until every item in `pm12-spec.md` §5 passes; this spec is written assuming that state is true by the time implementation starts. `db/repositories/product-offering-price.ts` exports only `findByOfferingIdWithDerivedEnd(db, productOfferingId)` (pm03's "Phase 1 finder file") — no write method exists yet. `types/audit.ts`'s `AUDIT_EVENT_TYPES` ends at `"PRODUCT_OFFERING_CREATED"` as of this writing; if pm13 and/or pm14 have landed first by the time this unit starts, it will additionally end with `"PRODUCT_OFFERING_UPDATED"`, `"PRODUCT_OFFERING_BRANCHED"`, `"PRODUCT_SPECIFICATION_CREATED"`, `"PRODUCT_SPECIFICATION_UPDATED"`, `"PRODUCT_SPECIFICATION_DELETED"` — either way, this unit only ever appends, never reorders. `tests/guardrails/product-module-boundaries.test.ts`'s `PRODUCT_WRITE_SERVICE_FILES` set currently contains only `"create-offering.ts"`; if pm13/pm14 have landed first it will also contain `"update-offering.ts"`, `"add-specification.ts"`, `"update-specification.ts"`, `"delete-specification.ts"` — this unit adds its own `"insert-price.ts"` to whatever that set already contains. `tests/db/product-repository-exports.test.ts`'s price-repository assertion currently expects **zero** mutation-named exports on `productOfferingPriceRepository` (no exception list at all) — see Design and §3.6 below for why this must change. No `services/product/insert-price.ts` exists yet. `validation/product/insert-price.schema.ts` does not exist yet. `validation/product/pricing-characteristics.schema.ts` exports `priceCharacteristicsSchema` (the `flat`/`tiered` XOR discriminated union, keyed `pricing_model`/`amount`/`pricing_characteristics`) and `tieredPricingCharacteristicsSchema` — both unchanged and untouched by this unit.

---

## 1. Goal

Let a `products:EDIT` caller add a price to a product offering: a write against a `DRAFT` offering inserts the price directly onto it; a write against an `ACTIVE` offering transparently clones the offering (and its specifications and prices, via `branchOfferingAsDraft`) into a new sibling `DRAFT` first and inserts the price onto that clone, leaving the `ACTIVE` row and its existing prices byte-for-byte untouched; a `startDateTime` more than 3 days in the past is rejected outright, one within the 3-day window is accepted and flagged — so that, by construction, the price repository never gains an `update*`/`delete*` method, only the one insert it will ever have.

## 2. Design

**Where `offeringId` lives — a function parameter, not a schema field.** Same convention pm13's `updateOffering`/pm14's `addSpecification` already established: `insert-price.schema.ts`'s field list (below) has no id field. `insertPrice(offeringId, input, actorId, now?)` takes the target offering's id as its own parameter, the same shape `addSpecification(offeringId, input, actorId)` uses — the caller (eventually pm22's Server Action) always already knows which offering row it's adding a price to before this service is ever called.

**Why this unit's routing has no "locate the cloned counterpart" step, unlike `updateSpecification`/`deleteSpecification`.** Adding a price is pure new content, exactly like `addSpecification` (pm14 §2): there is no existing row to find on the branch afterward, because the price being added doesn't exist anywhere until this call creates it. The branch-first routing here is the two-row table below, not the three-row table pm14's update/delete methods needed.

| Current status | Action | Audit event |
|---|---|---|
| `DRAFT` | `insertPrice(tx, offeringId, data)` directly | `PRODUCT_PRICE_ADDED` |
| `ACTIVE` | `branchOfferingAsDraft(tx, offeringId)` (no overrides), then `insertPrice(tx, branchedId, data)` | `PRODUCT_PRICE_ADDED` |
| `RETIRED` | rejected before any write (`OFFERING_RETIRED`) | — |

The `RETIRED` row is this spec's own addition, not literal build-plan text — the same disclosed addition pm13-spec and pm14-spec each made for their own services, for the same reason: `RETIRED` is terminal (project-overview-phase2, "Any transition out of `RETIRED`" is out of scope) and pm18's row-action matrix never renders an Add-price affordance on a `RETIRED` row, so this path isn't reachable from the shipped UI. Guarded here anyway, defensively, so a stray direct call gets a typed rejection rather than an accidental insert against a row this module's own invariants say must stay untouched.

**Lifecycle status must be revalidated at transaction time, not read once ahead of it (post-ship review fix, 2026-07-22).** The status driving this table's routing decision is re-fetched through `tx`, immediately before the `DRAFT`/`ACTIVE`/`RETIRED` branch above is evaluated — not read once via `db` before the transaction opens and reused. An offering's `lifecycleStatus` can change (activation, retirement, a concurrent branch) between an earlier pre-transaction read and this write; routing on a stale value could insert directly onto a row that has since gone `ACTIVE` (violating Inv. 14 — an `ACTIVE` offering's prices must never be mutated in place) or proceed against a row that has since gone `RETIRED`. This mirrors the same fix applied to pm14's `addSpecification`/`updateSpecification`/`deleteSpecification`.

**Why the backdating tolerance is checked twice — once in the Zod schema's refinement, once in the service — and why that isn't redundant duplication.** `pm99-build-plan-phase2.md`'s own text places the refinement in `insert-price.schema.ts` ("adds a refinement rejecting a `startDateTime` more than 3 days in the past"). `prodmgmt-code-standards-phase2.md` §6 rule 14 places the authoritative enforcement in the service instead ("enforced in `insert-price.ts`... checked against the transaction's `now()`... not in the Zod schema alone — Zod can check 'is this a valid date,' not 'is this within tolerance of the current instant at write time'"). Both are true and both are implemented, at two different layers, because they answer two different questions:
- The schema's `superRefine` calls `Date.now()` fresh, inside its own callback (never at module load, so it isn't frozen at import time — see §3.1), giving whichever future caller runs `.safeParse()` (pm22's Server Action) a fast, field-level rejection before ever reaching this service at all.
- The service's own check, `insertPrice(offeringId, input, actorId, now = new Date())`, is the one this unit's own integration test exercises directly — the same way pm11's, pm13's, and pm14's own integration tests call their services directly, with no Server Action in front of them yet to have run `safeParse` first. If the tolerance check lived in the schema alone, calling this service directly (as this unit's tests, and any future non-HTTP caller, necessarily do) would let a backdated-beyond-tolerance price insert silently, because nothing between the caller and the repository would ever re-check it.

This mirrors pm13-spec's own framing of `updateOfferingDraftInPlace`'s `WHERE lifecycle_status = 'DRAFT'` clause as "a backstop, not the primary check" — just with the layering reversed: here the upstream (schema) layer is the fast, user-facing check and the downstream (service) layer is the authoritative, transaction-time one. The 3-day constant (`THREE_DAYS_MS`) is declared once in each file rather than imported from one into the other — the same "small, two-caller helper, not worth a shared module" judgment call pm14-spec made for its duplicated `findClonedCounterpart`/`recordsEqual` pair.

**Why `insert-price.schema.ts` nests `priceCharacteristicsSchema` as a field rather than re-declaring its two branches.** `priceCharacteristicsSchema` is a `z.discriminatedUnion` keyed on `pricing_model`, with each branch a `z.strictObject`. Zod discriminated unions don't support `.extend()` on the union itself, and intersecting a `strictObject` branch with a second object carrying this unit's own envelope fields (`name`, `priceType`, `currency`, `glCode`, `startDateTime`) would fail at parse time — a `strictObject` rejects any key not in its own three-key shape, and `z.intersection` validates the *whole* input against each side independently, so the branch's strict check would see the envelope's keys as unrecognized. Re-declaring the two branches with the envelope fields merged in (i.e., duplicating `pricing_model`/`amount`/`pricing_characteristics` per branch) was considered and rejected: it would mean this unit's schema and pm02's `priceCharacteristicsSchema` each independently encode the same XOR/tier-contiguity rules (Inv. #4, #5), with two places that could silently drift apart. Nesting instead — `priceCharacteristics: priceCharacteristicsSchema` as a single field on this unit's own (non-strict) `z.object` — reuses the existing schema wholesale, snake_case keys and all (`pricing_model`, `amount`, `pricing_characteristics`), with zero duplication and full type narrowing preserved on `InsertPriceInput["priceCharacteristics"]`. No renaming layer is added; this unit reuses the schema exactly as pm02 shipped it, the same way `db/seeds/product.ts` already consumes it directly.

**Field scope — only what `prodmgmt-project-overview-phase2.md`'s Features section actually names.** That section's literal list for "Add price" is: "name, price type, pricing model (flat or tiered), currency, GL code, start date." `product_offering_price` also has three other nullable columns from Phase 1 — `recurring_charge_period_length`, `recurring_charge_period_type`, `unit_of_measure` — none of which appear in that field list, and none of which the companion mockup's Add-price dialog renders either (it shows only price name, type, amount, and start date). This unit's `insert-price.schema.ts` and `insertPrice(tx, data)` therefore validate/accept exactly the six named fields (`name`, `priceType`, `currency`, `glCode`, `startDateTime`, plus `pricingModel`/`amount`/`pricingCharacteristics` via the nested schema) and hardcode `recurringChargePeriodLength: null`, `recurringChargePeriodType: null`, `unitOfMeasure: null`, and `policy: null` at the repository insert call site — the same "excluded, not merely defaulted" discipline pm11 used for `isBundle` (there is no code path here that reads a value for these four columns off any caller input; they fall to a hardcoded `null` literal, not a caller-suppliable default). This is additive-safe: a later phase that needs to let users set a recurring cadence or a unit of measure on price creation adds new optional fields to this schema and this repository call, exactly the same low-risk shape pm13 added `saveAsNew` on top of pm11's three-field `create-offering.schema.ts`. Nothing in this unit's own build-plan text or the project overview asks for cross-field rules like "recurring price types must supply a period length" — none is invented here.

**Why there is no per-`(offeringId, priceType, startDateTime)` duplicate check.** `product_offering_price_type_start_unique` (pm02's own unique index) already exists on the table and will reject a genuine duplicate at the DB level with a raw Postgres unique-violation error. This unit does not catch or translate that into a typed result code — nothing in the build plan or authorizing docs asks for one, and the realistic trigger (two "Add price" submissions for the same offering, price type, and instant) isn't a scenario either the project overview or the mockup addresses. Disclosed as a known gap, not silently unhandled: if a future reviewer wants a typed `DUPLICATE_PRICE_WINDOW`-style code, that is a small, additive change to this service alone.

**Result shape carries `branched` and `backdated`, mirroring `AddSpecificationResult`'s `branched` and reusing the "was this backdated" signal from the tolerance check itself.**

```ts
export type InsertPriceResult =
  | {
      ok: true;
      offeringId: string;
      productOfferingPriceId: string;
      branched: boolean;
      backdated: boolean;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "BACKDATED_START_TOO_FAR" };
```

`backdated: true` means the price's `startDateTime` was in the past (relative to `now`) but within the 3-day tolerance — the non-blocking warning case the project overview describes ("the form shows a non-blocking warning when it is"). `backdated: false` covers both "not backdated at all" (start is now or in the future) and is never `true` on an `ok: false` result, since a beyond-tolerance backdate short-circuits to `BACKDATED_START_TOO_FAR` before any insert happens.

**Why `insertPrice`'s repository method takes no status backstop, unlike `updateOfferingDraftInPlace`'s defensive `WHERE lifecycle_status = 'DRAFT'` clause.** Same reasoning pm14-spec gave for its own three specification-write methods: the build plan's own wording for this unit says the repository method has "unchanged signatures" and the caller (this unit's own service) guarantees the target offering is always `DRAFT` by the time this method is called — via branch-first routing, exactly like pm14. This is also structurally necessary here for the same reason it was for specifications: `product_offering_price` carries no `lifecycle_status` column of its own (status lives only on the parent `product_offering`), so any backstop would require a join this unit's file list (`db/repositories/product-offering-price.ts` only) does not ask for.

**No visual/UI design in this unit** — backend service/data-access layer only, per the build plan's boundary. `actions/product/insert-price.action.ts`, `add-price-dialog.tsx`, and `price-form.tsx` all belong to pm22.

## 3. Implementation

### 3.1 Validation — `validation/product/insert-price.schema.ts` (new)

```ts
import { z } from "zod";

import { PRICE_TYPES } from "@/types/product";
import { priceCharacteristicsSchema } from "@/validation/product/pricing-characteristics.schema";

// 3-day backdating tolerance (Design; prodmgmt-architecture-phase2 §3, §6
// Inv. 2 amendment). Declared independently in services/product/insert-price.ts
// too — this file's copy is a fast-fail, parse-time check; the service's
// copy is the authoritative, transaction-time check (Design). Same
// small-duplication judgment call pm14-spec made for its two-caller
// findClonedCounterpart/recordsEqual helpers.
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export const insertPriceSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Price name is required")
      .max(200, "Price name must be 200 characters or fewer"),
    priceType: z.enum(PRICE_TYPES),
    currency: z.string().trim().length(3, "Currency must be a 3-letter code"),
    glCode: z
      .string()
      .trim()
      .max(50, "GL code must be 50 characters or fewer")
      .nullable()
      .default(null),
    startDateTime: z.coerce.date(),
    // Reused wholesale, snake_case keys and all (Design) — the amount/tiers
    // XOR (Inv. #5) and tier-contiguity (Inv. #4) invariants stay defined in
    // exactly the one place pm02 shipped them; no re-declaration here.
    priceCharacteristics: priceCharacteristicsSchema,
  })
  .superRefine((value, ctx) => {
    // `Date.now()` is called inside this callback, so it is evaluated fresh
    // on every parse — not frozen at module load. Fast-fail copy only; the
    // authoritative check lives in services/product/insert-price.ts against
    // an injectable `now` (Design).
    const msSinceStart = Date.now() - value.startDateTime.getTime();
    if (msSinceStart > THREE_DAYS_MS) {
      ctx.addIssue({
        code: "custom",
        message: "Start date cannot be more than 3 days in the past.",
        path: ["startDateTime"],
      });
    }
  });

export type InsertPriceInput = z.infer<typeof insertPriceSchema>;
```

No `offeringId` key (Design). No `recurringChargePeriodLength`/`recurringChargePeriodType`/`unitOfMeasure`/`policy` keys (Design, field-scope note) — these are not merely defaulted, they are absent from the type entirely, the same "can't be threaded through even by mistake" guarantee pm11 established for `isBundle`. `200`-character ceiling on `name` matches `create-offering.schema.ts`/`create-specification.schema.ts`'s own ceiling for visible consistency, not a DB-enforced limit (the column is unconstrained `text`).

### 3.2 Repository — `db/repositories/product-offering-price.ts` (edit — add `insertPrice`)

Add one new import (the type this method's `pricingCharacteristics` parameter needs — not currently imported by this file):

```ts
import type { TieredPricingCharacteristics } from "@/validation/product/pricing-characteristics.schema";
```

Add to the existing `productOfferingPriceRepository` object, alongside `findByOfferingIdWithDerivedEnd`:

```ts
// pm15-spec §3.2. The only write this repository will ever gain (Inv. #1,
// permanent) — no update*/delete*, ever. `productOfferingId` is supplied by
// the caller — the service already knows whether that's the original DRAFT
// offering or a freshly branched clone (Design, mirroring pm14's
// insertSpecification). No status backstop here: this table has no
// lifecycle_status column of its own, and "target is always DRAFT" is a
// caller guarantee (build plan's own wording, §pm15 header).
async insertPrice(
  tx: Database,
  data: {
    productOfferingId: string;
    name: string;
    priceType: PriceType;
    currency: string;
    glCode: string | null;
    pricingModel: PricingModel;
    amount: string | null;
    pricingCharacteristics: TieredPricingCharacteristics | null;
    startDateTime: Date;
  },
): Promise<{ productOfferingPriceId: string }> {
  const [row] = await tx
    .insert(productOfferingPrice)
    .values({
      productOfferingId: data.productOfferingId,
      name: data.name,
      priceType: data.priceType,
      // Not yet user-settable in this phase (Design, field-scope note) —
      // columns stay nullable and untouched, matching Phase 1's own shape.
      recurringChargePeriodLength: null,
      recurringChargePeriodType: null,
      unitOfMeasure: null,
      amount: data.amount,
      currency: data.currency,
      glCode: data.glCode,
      pricingModel: data.pricingModel,
      policy: null,
      pricingCharacteristics: data.pricingCharacteristics,
      startDateTime: data.startDateTime,
      // `productOfferingPriceId` and `createdAt` both absent — fall through
      // to their column defaults (fresh PRDOFP… id, `now()`), the same
      // "omitted, not merely coincidentally unset" discipline insertOffering
      // used for its own auto-generated id.
    })
    .returning({
      productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
    });
  if (!row) {
    throw new Error("insertPrice: insert returned no row");
  }
  return { productOfferingPriceId: row.productOfferingPriceId };
},
```

`findByOfferingIdWithDerivedEnd`'s existing body, its `toDateOrNull` helper, and this file's existing imports (`asc`, `eq`, `sql`, `Database`, `productOfferingPrice`, `PriceCard`, `PriceType`, `PricingModel`) are all untouched — this unit adds one new type import and one new method to the exported object literal, nothing else.

### 3.3 Audit event type — `types/audit.ts` (edit — append one entry)

```ts
export const AUDIT_EVENT_TYPES = [
  // ...all existing entries, unchanged...
  "PRODUCT_PRICE_ADDED",
] as const;
```

Append only, at whatever position the array currently ends (Codebase state, above — may be right after `"PRODUCT_OFFERING_CREATED"`, or after pm13's/pm14's entries if either or both have already landed). Do not reorder or touch any existing entry.

### 3.4 Service — `services/product/insert-price.ts` (new)

```ts
import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";

// Same tolerance value as insert-price.schema.ts's own copy — declared
// independently, not imported, per Design's duplication note.
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export type InsertPriceResult =
  | {
      ok: true;
      offeringId: string;
      productOfferingPriceId: string;
      branched: boolean;
      backdated: boolean;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "BACKDATED_START_TOO_FAR" };

// pm15-spec §3.4. Branch-first when the target offering is ACTIVE (Design);
// adding a price never needs to "locate a counterpart" the way pm14's
// update/delete methods do, since it is new content, not an action against
// existing content. `now` defaults to the real clock but is injectable for
// deterministic tests, mirroring services/product/get-offering-detail.ts's
// own `now: Date = new Date()` convention.
export async function insertPrice(
  offeringId: string,
  input: InsertPriceInput,
  actorId: string,
  now: Date = new Date(),
): Promise<InsertPriceResult> {
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

  // Authoritative backdating check (Design) — against this call's own
  // `now`, not whatever `Date.now()` returned when the schema's superRefine
  // ran at parse time.
  const msSinceStart = now.getTime() - input.startDateTime.getTime();
  const backdated = msSinceStart > 0;
  if (msSinceStart > THREE_DAYS_MS) {
    return { ok: false, code: "BACKDATED_START_TOO_FAR" };
  }

  const priceData = {
    name: input.name,
    priceType: input.priceType,
    currency: input.currency,
    glCode: input.glCode,
    pricingModel: input.priceCharacteristics.pricing_model,
    amount: input.priceCharacteristics.amount,
    pricingCharacteristics: input.priceCharacteristics.pricing_characteristics,
    startDateTime: input.startDateTime,
  };

  return db.transaction(async (tx) => {
    let targetOfferingId = offeringId;
    let branched = false;

    if (offering.lifecycleStatus === "ACTIVE") {
      const { offeringId: branchedId } =
        await productOfferingRepository.branchOfferingAsDraft(tx, offeringId);
      targetOfferingId = branchedId;
      branched = true;
    }

    const { productOfferingPriceId } =
      await productOfferingPriceRepository.insertPrice(tx, {
        productOfferingId: targetOfferingId,
        ...priceData,
      });

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_PRICE_ADDED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING_PRICE",
      targetId: productOfferingPriceId,
      beforeData: null,
      afterData: {
        offeringId: targetOfferingId,
        ...(branched ? { branchedFromOfferingId: offeringId } : {}),
        ...priceData,
        backdated,
      },
    });

    return {
      ok: true,
      offeringId: targetOfferingId,
      productOfferingPriceId,
      branched,
      backdated,
    };
  });
}
```

`targetEntity: "PRODUCT_OFFERING_PRICE"` follows the existing convention of uppercasing the underlying table name (`product_offering_price` → `"PRODUCT_OFFERING_PRICE"`), matching `createOffering`'s `"PRODUCT_OFFERING"` and pm14's `"PRODUCT_SPECIFICATION"`. `beforeData: null` mirrors `createOffering`'s and `addSpecification`'s own audit shape — a price add has no "before" state, it is new content. `afterData.backdated` is this unit's own disclosed addition (not literal build-plan text) so a reviewer reading the audit log can see the flagged case without cross-referencing `startDateTime` against the event's own timestamp by hand — the same transparency reasoning pm13/pm14 used for `branchedFromOfferingId`.

### 3.5 Guardrail test — `tests/guardrails/product-module-boundaries.test.ts` (edit — extend `PRODUCT_WRITE_SERVICE_FILES` only)

```ts
const PRODUCT_WRITE_SERVICE_FILES = new Set([
  "create-offering.ts",
  // "update-offering.ts", "add-specification.ts", "update-specification.ts",
  // "delete-specification.ts" — present here already if pm13/pm14 landed
  // first; do not remove any of them if so.
  "insert-price.ts",
]);
```

Same reasoning pm14-spec §3.8 gave for its own three additions: `insert-price.ts` legitimately imports `insertAuditEvent` (Design), so without this edit the "no product read path imports the audit-log write path" guardrail would start failing the moment this unit's service file exists. Strictly additive — one `Set` literal gains one more entry, no other line in the test file changes. **No other edit needed in this file:** its separate assertion, "the price repository's exported methods include no update*/delete* (insertPrice excepted)" (§9 guardrail from `prodmgmt-code-standards-phase2.md`, already present in this file as of pm09), already whitelists `insertPrice` by name via a negative-lookahead regex (`/^(update|delete|insert(?!Price\b))/`) — it was written in anticipation of this exact unit and needs no change; confirm it still passes rather than "fixing" something that isn't broken.

### 3.6 Structural test — `tests/db/product-repository-exports.test.ts` (edit — except `insertPrice` from the price-repository assertion)

This file's price-repository test currently asserts **zero** mutation-named exports on `productOfferingPriceRepository`, with no exception list — its own comment already anticipates this unit by name: *"The price repository's `update*`/`delete*` prohibition stays PERMANENT (Inv. #1) — at CRUD time its pattern relaxes for `insert*` only (a new `insertPrice`), never for update/delete on prices."* This unit is that relaxation. Change:

```ts
it("productOfferingPriceRepository exports no update*/delete* mutation function (insertPrice excepted, Phase 2 pm15)", () => {
  const names = Object.keys(productOfferingPriceRepository);
  const forbidden = names.filter(
    (n) => MUTATION_NAME_PATTERN.test(n) && n !== "insertPrice",
  );
  expect(forbidden).toEqual([]);
});
```

This is the exact same shape as this file's own `productOfferingRepository` assertion just above it (which whitelists `insertOffering`, added by pm11) — the price-repository assertion now follows the identical pattern, whitelisting exactly one name. `productSpecificationRepository`'s assertion (whitelisting nothing) is untouched by this unit — pm14 will update it if/when `product-specification.ts` gains write methods, independently of this edit.

### 3.7 No schema change, no Server Action, no UI in this unit

`db/schema/product.ts` is untouched — this unit writes existing columns only, on a table pm02 already shipped. `actions/product/insert-price.action.ts`, `add-price-dialog.tsx`, and `price-form.tsx` all belong to pm22. Per the build plan's boundary line and dependency graph, no file under `actions/`, `components/`, or `app/` changes in this unit.

## 4. Dependencies

**No new npm packages.** Zod, Drizzle, and the Postgres driver are already installed and already used by every existing validation schema, repository, and write service in this codebase. **No DB extensions, no migration.**

## 5. Verify when done

**Diff hygiene**
- [ ] `git status` shows only: `validation/product/insert-price.schema.ts` (new), `db/repositories/product-offering-price.ts` (one new type import, one new method added; `findByOfferingIdWithDerivedEnd` and its `toDateOrNull` helper untouched), `types/audit.ts` (exactly one new array entry, appended last), `services/product/insert-price.ts` (new), `tests/guardrails/product-module-boundaries.test.ts` (one `Set` literal extended by exactly one entry), `tests/db/product-repository-exports.test.ts` (the price-repository assertion's forbidden-name filter gains one exception). No `actions/`, `components/`, `app/`, or `db/schema/` changes.
- [ ] `db/repositories/product-offering.ts` is untouched by this unit — `branchOfferingAsDraft`'s own file gains nothing here (this unit only *calls* it).
- [ ] `insert-price.schema.ts`'s exported type has no `offeringId`, `recurringChargePeriodLength`, `recurringChargePeriodType`, `unitOfMeasure`, or `policy` key — grep confirms no code path in this diff reads any of these five off `input`/`data` before the hardcoded literals at the repository call site (four of them `null`; `offeringId` supplied only as a separate function parameter).

**Backend correctness — direct `DRAFT` path**
- [ ] Calling `insertPrice(draftId, input, actorId)` against a seeded `DRAFT` offering with a flat-priced `input` inserts exactly one new row into `product_offering_price` with `product_offering_id = draftId` and every field matching `input` (`recurring_charge_period_length`/`recurring_charge_period_type`/`unit_of_measure`/`policy` all `NULL`), and leaves the offering's own row (including `version`) and its other specification/price rows unchanged.
- [ ] The same call with a tiered-priced `input` (`pricing_model: "tiered"`, a `tiers` array) inserts a row with `amount IS NULL` and `pricing_characteristics` matching the submitted tiers exactly.
- [ ] Exactly one audit row appears: `event_type = 'PRODUCT_PRICE_ADDED'`, `target_entity = 'PRODUCT_OFFERING_PRICE'`, `target_id` equal to the new price's id, `before_data = null`, `after_data` matching the submitted fields plus `offeringId: draftId`, `backdated`, and no `branchedFromOfferingId` key.
- [ ] Result is `{ ok: true, offeringId: draftId, productOfferingPriceId: <newId>, branched: false, backdated: <matches the case> }`.

**Backend correctness — branch-first path**
- [ ] Calling `insertPrice` against an `ACTIVE` offering (e.g. the seed's `TOREMOVE-Template-5G-Nationwide-Service-Plan`) leaves that row and every one of its existing specification/price rows byte-identical afterward (re-fetch and compare against a pre-call snapshot).
- [ ] The call produces exactly one new sibling `DRAFT` row (via `branchOfferingAsDraft`) whose prices are the source's original set **plus** the newly added one; the new price's `product_offering_id` points at the new draft, not the source.
- [ ] The audit row's `target_id` is the new price's id (which belongs to the new draft), `after_data.offeringId` equals the new draft's id, and `after_data.branchedFromOfferingId` equals the source `ACTIVE` offering's id.
- [ ] Result is `{ ok: true, offeringId: <newDraftId>, productOfferingPriceId: <newPriceId>, branched: true, backdated: <matches the case> }` where `<newDraftId>` differs from the source id.

**Backend correctness — backdating boundary**
- [ ] Calling `insertPrice` with `startDateTime` exactly `now - 3 days` succeeds; the inserted row's `start_date_time` matches exactly; the result's `backdated` is `true`.
- [ ] Calling `insertPrice` with `startDateTime` exactly `now - 4 days` returns `{ ok: false, code: "BACKDATED_START_TOO_FAR" }` and performs zero `INSERT`s against `product_offering_price` and zero audit writes (and, on an `ACTIVE` target, zero calls to `branchOfferingAsDraft` — the check runs before any transaction opens).
- [ ] Calling `insertPrice` with `startDateTime` in the future returns `backdated: false` on success.
- [ ] Calling `insertPrice` with `startDateTime` equal to `now` returns `backdated: false` on success (not backdated at all).
- [ ] `insertPriceSchema.safeParse(...)` independently rejects a `startDateTime` more than 3 days before its own parse-time `Date.now()` with a Zod issue on the `startDateTime` path, and accepts one exactly 3 days prior — confirmed as a separate check from the service's own, by calling `safeParse` directly without going through `insertPrice`.

**Backend correctness — not-found and terminal-status guards**
- [ ] `insertPrice` returns `{ ok: false, code: "OFFERING_NOT_FOUND" }` for a nonexistent `offeringId` and writes nothing.
- [ ] `insertPrice` returns `{ ok: false, code: "OFFERING_RETIRED" }` against a `RETIRED` offering, calls neither `branchOfferingAsDraft` nor `productOfferingPriceRepository.insertPrice`, and writes no audit row.

**Structural — price repository stays insert-only**
- [ ] `Object.keys(productOfferingPriceRepository)` is exactly `["findByOfferingIdWithDerivedEnd", "insertPrice"]` (order-independent) — no `update*`/`delete*` name present.
- [ ] `tests/db/product-repository-exports.test.ts`'s updated price-repository assertion passes with `insertPrice` as its sole exception.
- [ ] `tests/guardrails/product-module-boundaries.test.ts`'s pre-existing "the price repository's exported methods include no update*/delete* (insertPrice excepted)" assertion passes unmodified (its regex already anticipated this method's name).

**Boundary**
- [ ] `services/product/insert-price.ts` and `validation/product/insert-price.schema.ts` contain no `next/*` import, no `"use server"` directive.
- [ ] `db/repositories/product-offering-price.ts` contains no import of `@/db/repositories/audit.repository`, no reference to `insertAuditEvent` or `AUDIT_LOG` — the "no product read path imports the audit-log write path" guardrail continues to pass for this file (repositories never audit).
- [ ] No `actions/product/` directory or file exists yet as a result of this unit (that's pm22).

**Build gates**
- [ ] `npm run typecheck` green — `InsertPriceInput`, `InsertPriceResult`, and `insertPrice`'s (both the repository's and the service's) parameter/return types all resolve with no manual `any`.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] Existing Phase 1, pm11, and pm12 tests still pass unmodified — this unit adds one schema, one repository method, one service file, one audit-type entry, and two small test-file edits; it touches no existing method's behavior or signature.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy, not the plan-folder mirror) gets a pm15 entry with the commit reference, once this actually ships.

Any failing item means the unit is not done. Unit pm22 (Price management UI) depends on `insertPrice`'s exact result shape — including `offeringId`/`productOfferingPriceId`/`branched`/`backdated` — existing and verified; do not start it until every item above passes. Unit pm16 (Activation & Retirement) depends on being able to populate a `DRAFT` with at least one price through this unit's real service (not raw fixture SQL) before exercising its own activation-precondition tests; do not start pm16's price-precondition fixtures until this unit ships.
