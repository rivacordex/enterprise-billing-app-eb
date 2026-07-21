# Product Management — AI Workflow Rules Addendum (Phase 2: CRUD Fast-Follow)

**Status:** PLANNED — decisions agreed 2026-07-20, pre-implementation.
**Base document:** `prodmgmt-ai-workflow-rules.md` (v1, shipped, **unchanged by this addendum**). Read that document first, then this addendum, then the companion docs below — this file records **only what Phase 2 adds or changes**, using the base document's section numbers.

**Companion docs (authoritative — do not restate or contradict):**

- `_change-product-crud-plan.md` — the decision record: resolved open questions, the copy-on-write versioning model, what CRUD means per entity.
- `_change-product-crud-implementation-guide.md` — **the authoritative unit-by-unit build order for Phase 2.** This addendum's §2 does not restate it (see below) — go there for the actual 10 units, their prompts, and their verify steps.
- `prodmgmt-architecture-phase2.md`, `prodmgmt-code-standards-phase2.md`, `prodmgmt-ui-context-phase2.md` — the other three companion-doc addenda, same relationship to their v1 originals as this file has to its own.

**Precedence unchanged** from the base document: module architecture Invariants → overview → architecture → code-standards → workflow rules (base, then this addendum) → general workflow rules.

---

## Supersession of the opening framing

The base document's first paragraph states the module's defining characteristic as: *"v1 is strictly read-only, so there are no mutation units, no Server Actions, no Route Handlers, and no new audit events."* **This is no longer true and is superseded, not amended.** Phase 2 is exactly the mutation phase that sentence was describing the absence of. Every general-doc rule that sentence exempted the module from (§3.3 mutation-splitting, §8.6 atomic audit) now applies in full — see §8 below.

## Relative to §1 (Operating Approach — Module Specifics)

| # | v1 said | Phase 2 changes it to |
|---|---|---|
| 1.1 | "Build only v1 scope... Treat any mutation request as the CRUD fast-follow — a separate, explicitly authorized phase." | **This authorization has now been given** — `_change-product-crud-plan.md` plus the conversation that produced it constitute it. Phase 2 units build only what that plan and the implementation guide specify — the "no speculative mutation work" discipline continues, just against a different (now-authorized) scope boundary. Building anything beyond what those two documents describe is still unauthorized, exactly as v1's out-of-scope items were. |
| 1.4 | "Do the route-group rename first among UI steps." | Historical, already done (pm01) — no Phase 2 equivalent "must go first" platform change exists. |

## Relative to §2 (Units — One at a Time)

**Not restated here.** The base document's §2 lists v1's 8 units inline because v1's plan and its unit list were the same size and grain. Phase 2's unit list lives in `_change-product-crud-implementation-guide.md` (10 units, schema migration through ship gate) — treat that document as this section's content by reference. The general discipline is unchanged: one unit at a time, in dependency order, no unit starts before the previous one is verified and committed (general doc §2; implementation guide §"Step 1" restates this for Phase 2 specifically).

## Relative to §3 (Scoping — No Speculative Changes)

| # | v1 said | Phase 2 changes it to |
|---|---|---|
| 3.1 | "Do not create `actions/product/`, `app/api/product*`, mutation service methods, lifecycle-transition logic, or EDIT/DELETE-gated UI. Their creation marks the start of the CRUD fast-follow and requires explicit instruction." | That instruction has been given, for exactly what's in `_change-product-crud-plan.md`. `app/api/product*` remains forbidden permanently — that part of the rule doesn't expire. |
| 3.3 | "Do not add columns, flags, or abstractions the current unit doesn't need — including... versioned offering rows (Inv. #8)." | **Superseded for `family_offering_id` and versioned offering rows specifically** — that's now the authorized design (`prodmgmt-architecture-phase2.md` Inv. 8). The general spirit of the rule (don't add speculative columns/abstractions beyond what's specified) still applies to everything else — this is a named, reviewed exception, not a loosening of the rule generally. |

**New Phase-2-specific "do not" list (forbidden in every unit, not just early ones):**

5. **Do not** add `update*`/`delete*` to the price repository, in any unit, for any reason — this is forbidden in every phase, v1 and Phase 2 alike (Inv. 1, unchanged).
6. **Do not** add a hard-delete path for offerings or for a specification on a non-`DRAFT` offering — every removal is a status transition (Discard/Retire) or the existing DRAFT-only spec delete, never a row deletion.
7. **Do not** make `is_bundle` user-settable in any form, dialog, or schema — confirmed decision, not an oversight to "complete later."
8. **Do not** write an in-place `UPDATE` to an `ACTIVE` offering's own columns, its specifications, or its prices, in any service — always branch first (Inv. 14). If a unit seems to need an exception to this, stop and ask — it almost certainly means the branch primitive is being bypassed, not that an exception is warranted.
9. **Do not** attempt to merge two version families, split one family into two, or move a row from one family to another — out of scope, not designed, and not requested.

## Relative to §4 (When to Split)

Phase-2-specific split triggers, in addition to the general doc's:

6. **Split the schema migration from everything else** — `family_offering_id` + its index lands and is verified in complete isolation before any repository code depends on it (mirrors v1's "split the migration from behavior," §4.2 of the base doc).
7. **Split the branch primitive (`branchOfferingAsDraft`) from every service that calls it** — build and thoroughly test it as its own unit before wiring it into `update-offering.ts`, `add-specification.ts`, `insert-price.ts`, etc. Every one of those services depends on it behaving correctly; none of them should be the first place its behavior gets exercised.
8. **Split the guardrail/versioning-invariant tests to land with the Server Actions unit, not after** — same discipline v1 used for its authz-matrix entry (base doc §4.4), applied to the new single-active-per-family and branch-not-mutate tests specifically.

## Relative to §5 (Missing or Ambiguous Requirements)

Of v1's originally-deferred items (base doc §5.1): `policy` column semantics, tier-storage-to-child-table migration, and bundle composition **remain deferred** — Phase 2 does not resolve them either, and no unit should assume an answer. Pricing-visibility split also remains out of scope, unchanged.

The six items that **were** open at the start of this phase are now resolved and recorded in `_change-product-crud-plan.md`'s "Resolved decisions" section — do not re-ask any of them; cite that section if a unit's rationale needs to reference why.

**New items this phase leaves deliberately open, per `_change-product-crud-plan.md`'s "Open items still requiring attention"** — these are build-time judgment calls, not design forks requiring another stop-and-ask:

1. Exact UI copy differences beyond what `prodmgmt-ui-context-phase2.md` already specifies for Discard vs. Retire.
2. Whether the family-grouped Manage Products list needs its own read path or can post-filter `listOfferings` — implement whichever is simpler and document the choice inline (base doc §5.4: record the resolution in the owning companion doc).
3. Concurrent branching (two users branching the same `ACTIVE` offering near-simultaneously) is fine by design — only activation is exclusive, not branching. Do not add locking or a conflict error for this case unless a unit surfaces a concrete reason to.

## Relative to §6 (Protected Files — Module References)

All nine v1 protected-file entries still apply. Phase 2 adds:

10. **The `family_offering_id` linkage convention** (`NULL` = root, non-null always resolves to the root in one hop) is itself protected once Unit 1 (the migration) lands — changing this convention afterward would silently corrupt every family's version lineage. Touching it requires stopping and getting explicit confirmation, same as any other protected-file change.
11. **`app/(app)/products/product-offering/**` and its existing components** — Phase 2 may only touch the nav label and the page `H1` text there (per the plan's explicit cosmetic-only exception). Any other edit to that folder is out of bounds without stopping to explain why.
12. **The price repository's exported surface** (v1 item 9, restated for emphasis): `insertPrice` is the only write this file will ever gain, in this phase or any future one.

## Relative to §7 (Docs in Sync)

Extend v1's item 5 (component names are binding): Phase 2's binding names — `ManageProductsPage`, `ManageOfferingTable`, `OfferingForm`, `SpecificationForm`, `PriceForm`, `RetireOfferingDialog`, `CreateOfferingDialog`, `AddPriceDialog` — are pinned in `prodmgmt-code-standards-phase2.md` §4/§8; create them exactly as named there.

Everything else in §7 (permission map/registry/guard land together, cross-module doc edits need approval, owning-doc-per-fact) is unchanged — the four `-phase2.md` addenda are this phase's owning docs for their respective facts, same relationship v1's four docs have to each other.

## Relative to §8 (Verification — Before the Next Unit)

| # | v1 said | Phase 2 changes it to |
|---|---|---|
| 8.3 | "Audit — confirm no `AUDIT_LOG` writes were added: reads are not audited in v1... The general §8.6 transaction rule is not yet in play." | **General §8.6 is now in play for every mutation unit.** Every write service's transaction must end with an `insertAuditEvent` call using one of the new Phase 2 event types (`prodmgmt-code-standards-phase2.md` §1); verify the audit write is inside the same transaction as the data change, not a separate follow-up call. |

**New verification items for Phase 2 units, in addition to the (still-applicable) general §8 checklist:**

9. **Single-active-per-family** — after activating a draft, exactly one row in its family is `ACTIVE`; re-run under two near-simultaneous activation attempts and confirm the same holds.
10. **Branch-not-mutate** — after any edit/add-price/add-spec action against an `ACTIVE` offering, diff that exact row and its exact specification/price rows against their pre-action state — byte-identical, plus exactly one new sibling `DRAFT` exists.
11. **`is_bundle` immutability** — confirm no request payload, however constructed, can change an existing row's `is_bundle` value through any action.
12. **Schema-diff, not schema-freeze** — v1's "no schema change" verification becomes "the only schema change is `family_offering_id` + its index" — confirm `product_specifications` and `product_offering_price` remain byte-identical to their Phase 1 definitions.

If any item fails, the unit is not done (base doc §8, unchanged).
