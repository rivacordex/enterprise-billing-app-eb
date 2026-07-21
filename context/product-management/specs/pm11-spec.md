# PM11 — Backend: Create offering

- **Unit:** 11 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** Unit pm10 (`family_offering_id` column must exist, migrated and verified).
- **Authorizing sections:** `prodmgmt-architecture-phase2.md` §3 (Storage Model — root insert semantics, Inv. 8 supersession); `prodmgmt-code-standards-phase2.md` §1/§6 (`is_bundle` immutability, branch-not-mutate discipline extended to "creation never accepts it either"); `phase2-manage-products-crud-spec.md` Implementation §2–4 (`create-offering.schema.ts`, `insertOffering`, `create-offering.ts` service); `pm99-build-plan-phase2.md` Unit pm11 (this unit's literal contract).
- **Codebase state assumed at start (re-verify before implementing):** Unit pm10 shipped — `db/schema/product.ts`'s `productOffering` table has `familyOfferingId: text("family_offering_id")` (nullable, self-referencing FK) and migration `0010_product_offering_family.sql` is applied. `services/product/` currently has only two **read** files, `list-offerings.ts` and `get-offering-detail.ts` — no write service exists yet. `validation/product/` has only `product-spec-characteristics.schema.ts`, `pricing-characteristics.schema.ts`, `offering-list.schema.ts` — no mutation schemas yet. `db/repositories/product-offering.ts` exports only `productOfferingRepository.findList` / `.findDetailById` — no insert method yet. `types/audit.ts`'s `AUDIT_EVENT_TYPES` ends at `"PREFERRED_METHOD_CHANGED"` — no `PRODUCT_*` entries exist yet; this unit adds the first one.

---

## 1. Goal

Let a `products:EDIT` caller create a brand-new product offering as the root of its own version family — `insertOffering` always sets `family_offering_id = NULL`, `version = 1`, `lifecycle_status = DRAFT`, and hardcodes `is_bundle = false` regardless of what the caller's input contains — recorded as one `PRODUCT_OFFERING_CREATED` audit row in the same transaction as the insert.

## 2. Design

**Why `is_bundle` isn't in the input schema at all, not just stripped later:** the build plan is explicit — "no `isBundle` field, ever." Rather than accepting it in `CreateOfferingInput` and discarding it in the repository (which would still let a future caller *believe* the field does something), `create-offering.schema.ts` simply never defines the key. The repository then hardcodes the literal `false` at the insert call site, not from any field on `data`. Two independent layers refuse the value — the schema can't parse it in, and the repository can't read it out — so there's no single point of failure where a shortcut could reintroduce it.

**Why no uniqueness pre-check (unlike `createRole`'s name-conflict check):** `createRole` checks `findRoleByName` before opening a transaction because role names must be globally unique. Nothing in `prodmgmt-architecture-phase2.md` or the crud-plan requires offering names to be unique — two independently-named or even identically-named offerings can each be the root of their own family. So `createOffering` has no pre-transaction lookup; it goes straight to the transaction. This is a deliberate absence, called out so it isn't mistaken for an oversight when compared against the `createRole` exemplar.

**Why the transaction still exists for a single insert:** the insert alone has no atomicity requirement, but the insert-plus-audit-row pair does — exactly mirroring `createRole`'s reasoning (`db.transaction` wraps `insertRole` + `insertAuditEvent`, guaranteeing there's never an offering with no audit trail, or an audit row for an offering that didn't actually get created).

**Result shape:** `CreateOfferingResult` is a simple `{ ok: true; offeringId: string }` — no failure variant, unlike `CreateRoleResult`'s `NAME_CONFLICT` branch, because this unit has no business-rule rejection path (Zod validation failures are handled by the caller — pm19's Server Action — before this service is ever called; that boundary is exactly what `create-role.action.ts`'s `safeParse`-then-delegate pattern establishes, and pm11 does not own or duplicate it).

**No visual/UI design in this unit** — backend service/data-access layer only, per the build plan's boundary. No Server Action, no form, no page. Those are pm19 (per `pm99-build-plan-phase2.md`'s dependency graph, Server Actions land after every backend unit they call).

## 3. Implementation

### 3.1 Validation — `validation/product/create-offering.schema.ts` (new)

```ts
import { z } from "zod";

export const createOfferingSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Offering name is required")
    .max(200, "Offering name must be 200 characters or fewer"),
  isSellable: z.boolean(),
  billingOnly: z.boolean(),
});

export type CreateOfferingInput = z.infer<typeof createOfferingSchema>;
```

Mirrors `create-role.schema.ts`'s `.trim().min().max()` convention for the required string. `200` (not `100`, as in `roleName`) matches `product_offering.name`'s existing column — check `db/schema/product.ts`'s `name: text("name").notNull()` has no app-layer length precedent to copy from Phase 1's own validation, since v1 had no create path; `200` is this unit's judgment call, chosen to comfortably exceed the seeded `TOREMOVE-Template-*` names with headroom, not derived from a DB `varchar(n)` limit (the column is unconstrained `text`). Flagging this as a reasonable default, not a hard requirement from any authorizing doc — adjust freely if the team has a house convention. No `.nullish()` needed anywhere here: all three fields are required booleans/non-empty strings, unlike `roleDescr`'s optional pattern.

### 3.2 Repository — `db/repositories/product-offering.ts` (edit — add `insertOffering`)

Add to the existing `productOfferingRepository` object (alongside `findList` / `findDetailById`):

```ts
async insertOffering(
  tx: Database,
  data: { name: string; isSellable: boolean; billingOnly: boolean },
): Promise<{ offeringId: string }> {
  const [row] = await tx
    .insert(productOffering)
    .values({
      name: data.name,
      isSellable: data.isSellable,
      billingOnly: data.billingOnly,
      isBundle: false, // hardcoded — never sourced from caller input, no exceptions (Design)
      familyOfferingId: null, // this row is a family root
      lifecycleStatus: "DRAFT",
      version: 1,
    })
    .returning({ offeringId: productOffering.productOfferingId });
  if (!row) {
    throw new Error("insertOffering: insert returned no row");
  }
  return { offeringId: row.offeringId };
},
```

Note `data`'s type deliberately has no `isBundle` key — it cannot be threaded through even by an implementer's mistake, since there's no field to pass. `productOfferingId`, `lastModified`, and `lastEditedBy` are left to their column defaults/nullability (`productOfferingId` auto-generates via the `PRDOFR`-prefixed sequence default already in the schema; `lastModified` defaults to `now()`; `lastEditedBy` stays `NULL` — this unit's contract doesn't mention stamping an editor on create, and no existing repository method sets it either, so this is consistent with current practice, not a gap). `familyOfferingId: null` is written explicitly here (rather than omitted to fall through to the column default) to make the family-root guarantee visible directly in the insert call, matching how deliberately this value matters to the unit's stated visible result.

### 3.3 Audit event type — `types/audit.ts` (edit — append one entry)

```ts
export const AUDIT_EVENT_TYPES = [
  // ...existing entries, unchanged, through "PREFERRED_METHOD_CHANGED"...
  "PREFERRED_METHOD_CHANGED",
  "PRODUCT_OFFERING_CREATED",
] as const;
```

Append only — do not reorder or touch any existing entry. This is the first `PRODUCT_*` addition; later units (pm12 branch, pm16 activate, pm17 retire/discard, per the build plan) each append their own entries the same way, one unit at a time, so this unit's diff to this file is exactly one new array element.

### 3.4 Service — `services/product/create-offering.ts` (new)

```ts
import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { CreateOfferingInput } from "@/validation/product/create-offering.schema";

export interface CreateOfferingResult {
  ok: true;
  offeringId: string;
}

// pm11-spec §3.4. No pre-transaction uniqueness check (Design) — offering
// names are not required to be unique, unlike role names. The insert and its
// `PRODUCT_OFFERING_CREATED` audit row run atomically inside one transaction,
// exactly mirroring createRole's insert+audit pairing.
export async function createOffering(
  input: CreateOfferingInput,
  actorId: string,
): Promise<CreateOfferingResult> {
  const offeringId = await db.transaction(async (tx) => {
    const { offeringId } = await productOfferingRepository.insertOffering(
      tx,
      input,
    );

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_CREATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: offeringId,
      beforeData: null,
      afterData: {
        name: input.name,
        isSellable: input.isSellable,
        billingOnly: input.billingOnly,
      },
    });

    return offeringId;
  });

  return { ok: true, offeringId };
}
```

`targetEntity: "PRODUCT_OFFERING"` matches the existing naming convention of uppercasing the underlying table name (`roles` table → `"ROLES"`; `product_offering` table → `"PRODUCT_OFFERING"`, singular because the table name itself is singular — there is no existing plural-vs-singular rule stated anywhere, this just follows the table's own name literally). `afterData` intentionally omits `isBundle` and `familyOfferingId`/`version`/`lifecycleStatus` — it records what the *caller* supplied, not the server-assigned invariants, mirroring `createRole`'s `afterData` which likewise only records `roleName`/`roleDescr`, not any DB-assigned id or default. If a future audit-log reviewer needs to see the hardcoded invariants too, that's a call for whoever writes the audit-log *read* UI, not this unit.

### 3.5 No Server Action, no UI, no page in this unit

Per the build plan's boundary line ("no `next/*` imports") and dependency graph, `actions/product/create-offering.action.ts` and any form/dialog component belong to a later frontend unit (pm19, "Frontend: Create + edit offering" per `pm99-build-plan-phase2.md`'s unit list). Do not add either here even though it would be easy to keep going — the guardrail test in §5 checks for this boundary directly.

## 4. Dependencies

**No new npm packages.** Zod, Drizzle, and the Postgres driver are already installed and used by every existing validation schema, repository, and write service in this codebase. **No DB extensions.**

## 5. Verify when done

**Diff hygiene**
- [ ] `git status` shows only: `validation/product/create-offering.schema.ts` (new), `db/repositories/product-offering.ts` (one new method added, `findList`/`findDetailById` untouched), `types/audit.ts` (exactly one new array entry, appended last), `services/product/create-offering.ts` (new). No `actions/`, `components/`, or `app/` changes.
- [ ] `insertOffering`'s parameter type has no `isBundle` key, structurally — grep confirms no code path anywhere in this diff reads an `isBundle`/`is_bundle` value off `input`/`data` before the hardcoded `false` literal.

**Backend correctness**
- [ ] Calling `createOffering({ name: "Test Plan", isSellable: true, billingOnly: false }, actorId)` against a seeded/test DB returns `{ ok: true, offeringId }` where `offeringId` matches the `PRDOFR######` format.
- [ ] The inserted row has `family_offering_id IS NULL`, `version = 1`, `lifecycle_status = 'DRAFT'`, `is_bundle = false`.
- [ ] Calling it with a crafted input object that has an extra `isBundle: true` key (bypassing the type system, e.g. via `as any` in a test) still produces `is_bundle = false` in the DB — proving the guarantee holds even against a malformed caller, not just a well-typed one.
- [ ] Exactly one row appears in the audit log with `event_type = 'PRODUCT_OFFERING_CREATED'`, `target_entity = 'PRODUCT_OFFERING'`, `target_id` equal to the new offering's id, and `after_data` containing the three input fields.
- [ ] Two concurrent calls to `createOffering` with the same `name` both succeed (no uniqueness constraint anywhere blocks it) — confirms the deliberate absence of a name-conflict check.
- [ ] `family_offering_id`'s FK/CHECK constraints from pm10 are satisfied trivially since the value is always `NULL` on this path — no constraint violation possible from this unit's own code.

**Boundary**
- [ ] `services/product/create-offering.ts` and `validation/product/create-offering.schema.ts` contain no `next/*` import, no `"use server"` directive.
- [ ] No `actions/product/` directory or file exists yet after this unit (that's pm19).

**Build gates**
- [ ] `npm run typecheck` green — `CreateOfferingInput`, `CreateOfferingResult`, and `insertOffering`'s parameter/return types all resolve with no manual `any`.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] Existing Phase 1 tests and pm10's own verification suite still pass unmodified — this unit adds one new repository method and one new audit-type entry, touching no existing read path (`findList`/`findDetailById` are untouched).

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy, not the plan-folder mirror) gets a pm11 entry with the commit reference, once this actually ships.

Any failing item means the unit is not done. pm12 (`branchOfferingAsDraft`) depends on `insertOffering`'s exact insert shape existing and verified — do not start it until every item above passes.
