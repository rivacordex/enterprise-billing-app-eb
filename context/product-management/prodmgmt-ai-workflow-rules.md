# Product Management — AI Workflow Rules (Module Supplement)

Read `context/ai-workflow-rules.md` first — it is binding for every module and applies here unchanged; this file adds only what is specific to Product Management, and its numbering follows that document's sections. The module is **fully built and shipped** (View Product, Manage Products, Orders, Subscriptions; units pm01–pm34) and is now **under a planned update**: the Manage Products rebuild & catalog lifecycle change (`_updatemodule-product-manage-page-refactor-plan.md`, decisions D1–D13). Every rule below is written for the target state that update defines. Four rules in the previous version of this file are superseded by it — see **Appendix A** before you conclude that a rule here contradicts the shipped code.

**Companion docs (authoritative — cite them, never restate or contradict them):**

- `prodmgmt-project-overview.md` — product spec for the shipped module.
- `prodmgmt-update-overview.md` — product spec for the planned update: goals, 14-step core flow, features, in/out of scope, 14 success criteria.
- `_updatemodule-product-manage-page-refactor-plan.md` — the update's decisions (D1–D13), verified migration mechanics, verification items V1–V10, open items O1–O3, hand-offs H1–H3, delivery order U1–U5.
- `prodmgmt-architecture.md` — `product`/`ordering`/`inventory` schemas, permission matrix (§4), Module Invariants (§6; #1, #6, #13, #14, #17 amended and #23–29 added by this update).
- `prodmgmt-code-standards.md` — module conventions (§1–§7), permission map (§8), guardrails (§9), Appendix A (superseded rules).
- `prodmgmt-progress-tracker.md` — current progress plus the delivered build record (the "Completed Tracker" section at the end) and its recurring ripple patterns.

**Precedence:** architecture **Invariants** → update overview → architecture → code-standards → this supplement → general workflow rules.

---

## 1. Operating Approach

1. **Read the six companion docs in full before writing a line of code for this update.** They describe a shipped system plus an agreed change to it. Do not infer the current shape from the code alone: several shipped comments assert rules this update reverses (Appendix A).
2. **Cite the authorizing section before coding.** Name the decision (D1–D13), the success criterion, the Invariant, or the code-standards rule that mandates what you are about to build. No citation, no mandate — stop and ask.
3. **Do not start U1 until the six invariant amendments are approved.** `architecture.md` §7 Inv. #18 and `prodmgmt-architecture.md` Inv. #1, #6, #13, #14, #17 all require a documented design review. Until the user records that approval, write no schema, no repository write, and no service for this update. Building first and papering the invariant afterwards is a review-blocking defect.
4. **Do not start U1 until verification item V5 has been run.** Grep every `'RETIRED'` comparison outside `db/schema/product.ts` — `services/**`, `db/repositories/**`, `components/**`, `tests/**` and the flow SQL under `workflow-management/**` — and list them with the decision for each. The value's meaning changes in this update; a missed comparison silently mis-bills or mis-hides a version.
5. **Deliver in the plan's order: U1 schema → U2 repository and services → U3 validation → U4 page → U5 sweep and docs.** U1 blocks everything. U3 may land with U2. Do not begin U4 before U2's transitions pass their tests.
6. **Make the smallest correct change.** No refactor, rename, folder reorg or dependency change rides along with a unit.
7. **State the unit's scope, files, permissions and tests before editing**, and stop and re-scope the moment you touch a file that is not on that list.

### Permanent rules — they never expire, in any unit, in any future phase

- Never create `app/api/product*`, `app/api/ordering*` or `app/api/inventory*`.
- Never make `is_bundle` user-settable, in any schema, form or dialog.
- Never mutate an `ACTIVE` offering, its specifications or its prices in place — branch first via `branchOfferingAsDraft` (Inv. #14).
- Never read a status that gates a branch-or-write decision before the transaction opens. Read it on `tx`, locked, immediately before the decision. This exact TOCTOU bug was found and fixed four times (pm14, pm15, pm16, pm20); treat a pre-transaction status read as a review-blocking defect on sight.
- Never add `update*` or `delete*` to the `order_item_price_override` or `inventory_status_history` repositories (Inv. #16, #18).
- Never add a column matching `%cycle%` or `%frequency%` to `ordering.*` or `inventory.*` (Inv. #20).
- Never weaken order approval: it re-runs the full submission validation under locks and refuses reviewer = submitter, in the service and at the DB CHECK.
- Never add a migration or backfill that repoints a subscription's `product_offering_id`. Grandfathering is unconditional (Inv. #17).
- Never write into `enterprise-billing-app/` when the task is planning. Plans, specs and doc updates go to `_plan_enterprise-billing-app/`.

---

## 2. Units — One at a Time

1. **Build exactly these five units, in this order, each verified and committed before the next starts.** Each line states what the unit delivers and what it must not contain.

   | Unit | Delivers | Must not contain |
   |---|---|---|
   | **U1 — Schema** | The edited `0006_product.sql` (five-value enum, per-price-type CHECKs, unit-list CHECK, cascade child FKs), the two expression unique indexes, the DRAFT-guard trigger, a by-hand schema-mirror sync (no `drizzle-kit generate`; the `0006` snapshot and `meta/_journal.json` stay unchanged, D2), re-baselined guardrail 13 | Any repository, service, action or component change |
   | **U2 — Repository + services** | `findFamilyPage`, `findFamilyVersions`, DRAFT-only `updatePrice`/`deletePrice`, the five transition services, `deleteOffering`, the new audit event types | Any page or component change; any Zod change beyond what compiles |
   | **U3 — Validation** | The discriminated price-input schema, the per-price-type required fields, the unit enum, the charge-period mapping check, the family-list searchParams schema | Service logic; a second copy of a rule the DB already enforces |
   | **U4 — Page** | The families table, version bar, both editable panels, URL selection, inline editing, the five confirmation dialogs, the new actions | Any schema or service change; a per-row detail fetch of any kind |
   | **U5 — Sweep + docs** | The V5 literal sweep applied, seeds updated, the §9 doc amendments landed, V1–V10 green | New behaviour of any kind |

2. **Split any unit that grows past its row.** Finish the smaller piece first.
3. **Unit numbering — pm35–pm45 (user-authorised).** The user has authorised continuing the `pm` sequence for this update, so the authoritative buildable units are **pm35–pm45** (`specs/pm00-build-plan.md` §9), which map onto the U1–U5 buckets in the table above (U1 → pm35 + pm36, etc.; see pm00 §Sequencing notes). Cite pm-numbers for delivery and gates; U1–U5 remain the conceptual grouping only.
4. **Land each unit's tests in the same commit as its behaviour.** Deferring guardrail coverage to U5 repeats the pm24 finding, where guardrails 8, 9 and 14 went unverified for several units.

---

## 3. Scoping — No Speculative Changes

1. **Do not build anything in the update overview's *Out of scope* list.** Specifically: maker-checker or approval routing for catalog changes; what TESTING actually does; `PER_UNIT`, tiered or block rating; tiered recurring support in bm29; unit normalisation between catalog and rating feed; a billing basis for rate-based units; `policy` semantics; bundles or `bundle_link`; a TMF620 API; tier child tables.
2. **Do not touch Orders, Subscriptions, Customer, Accounts, billing or rating code.** The only reach outside `product` is the retirement gate's read of `inventory.product_inventory` through that module's locked repository finder, and the V5 literal sweep.
3. **Do not add a fourth table to the `product` schema**, and do not add a column the current unit does not need — no stored `end_date_time`, no `last_update`, no derived "is billable" column, no second version-like counter.
4. **Do not create a generic `setLifecycleStatus` helper, a state-machine module, or an action that takes a target status as a parameter.** One transition, one service, one audit event.
5. **Do not fetch per-row detail on a list page**, in any form: no `getOfferingDetail` in a loop, no `Promise.all` over rows, no concurrency-limited mapper. If a list needs a field, add it to the paged SQL.
6. **Do not reintroduce** `fetchAllForStatus`, `fetchAllOfferingRows`, `fetchSpecificationsByOfferingId`, `mapWithConcurrencyLimit`, `groupIntoFamilies`, `MAX_COMBINED_ROWS`, `OfferingFamilyRow`, `selectPrimary` or `resolveFamilyId` under any name.
7. **Do not add a fourth write to the price repository.** `insertPrice`, `updatePrice`, `deletePrice` — and the latter two refuse a parent that is not `DRAFT`.
8. **Do not add a hard-delete path for anything except a `DRAFT` or `TESTING` offering that was never `ACTIVE`.** An `ACTIVE`, `OBSOLETE` or `RETIRED` version and its children are never deleted by any path, migration included.
9. **Do not merge, split or re-parent version families.** Not designed, not requested.
10. **Do not fork a shared primitive.** The module has one action folder, one nav registry, one set of Administration table primitives, one money formatter, one datetime formatter. Extend; never copy.
11. **Do not disable, weaken or delete a guardrail to make a unit pass.** Re-baseline guardrail 13 against the target schema as U1's own deliverable; every other guardrail must pass as written.

---

## 4. When to Split

Apply the general doc §3, plus these:

1. **Split the migration from everything that depends on it.** U1 lands and is verified alone.
2. **Split each transition into its own unit-sized step** when U2 grows: submit-for-testing, return-to-draft, activate, obsolete, retire, delete. Each has its own preconditions, audit event and tests.
3. **Split a new write primitive from its callers.** Build and test `updatePrice`/`deletePrice` and the DRAFT guard before any service or UI calls them.
4. **Split the page by region.** Families table, version bar, specifications panel, pricing panel, dialogs — separate steps, each independently green.
5. **Split the V5 literal sweep from the behaviour change** if it turns up more than a handful of sites, and land the sweep first.
6. **When in doubt, split.**

---

## 5. Missing or Ambiguous Requirements

1. **Never guess on security, permissions, data shape, effectivity, versioning, lifecycle transitions or audit.** Stop and ask one precise question with options.
2. **Stop and ask on these named open items — do not resolve them yourself:**
   - **O1** — the exact `recurring_charge_period_length`/`_type` combinations bm29's resolver accepts. Until the user confirms them against bm29, do not write the CHECK's value list.
   - **O2** — whether `EA` stays in the unit list.
   - **O3** — whether `MB` and `GB` may coexist, or pre-rating normalises to one volume unit.
   - **H1–H3** — the rating-side hand-offs (unit spelling, rate-based unit basis, `PER_UNIT`). These are not this update's work; do not implement them because a test would be easier.
3. **Stop and ask if a unit appears to need an exception to branch-on-edit, to the DRAFT-only write rule, or to the delete rule.** It almost certainly means a primitive is being bypassed.
4. **Never invent a JSONB shape.** `product_spec_characteristics` and `pricing_characteristics` come from the Zod schemas in `validation/product/`.
5. **Never guess price effectivity or backdating.** End is derived from the successor's `start_date_time`; a future-dated successor does not displace the current price early; the tolerance is exactly 3 days, checked against the transaction's `now()`.
6. **Never guess versioning semantics.** `version` is a family-relative sequence number assigned once; `family_offering_id` resolves to the root in exactly one hop.
7. **Never guess what TESTING does.** In this update it is read-only, not orderable, not billable, reversible to DRAFT, and counts as the family's open version — nothing more. A request to give it behaviour is a new phase.
8. **Record every resolution in the owning companion doc** in the same change set, so the next agent does not re-ask.

---

## 6. Files You Must Not Modify Without Explicit Instruction

The general doc §5 list applies in full. Module-specific:

1. **`components/ui/`** — managed vendor layer. Compose new components in `components/products/` or `components/products/manage/`.
2. **Applied migrations** — forward-only, with **one authorized exception**: `db/migrations/0006_product.sql` may be edited in place, in U1 only, under decision D11's fresh-install assumption. That authorization covers `0006` and nothing else. Never edit another applied migration, and never extend this exception to a second round without asking.
3. **Never write a migration that adds an enum value and then uses it.** The migrator applies all pending files in one transaction and Postgres rejects the use (`unsafe use of new value`, verified). If the fresh-install assumption is withdrawn, the create-new-type-and-swap form is the only correct shape.
4. **`app/(app)/products/product-offering/**` and `components/products/*.tsx`** — View Product's route folder may be touched only for nav label or page `H1` text. You may **import** `components/products/*` from `components/products/manage/**`; you may not edit those files to suit Manage Products. If a shared component needs a prop it does not have, stop and ask.
5. **`workflow-management/**`** — read-only from this module. The V5 sweep reports what it finds there; it does not change it.
6. **Better-Auth managed tables and the `auth/` field mapping** — this module only FKs `core.APPUSER`.
7. **The permission registry mechanism** — the `products` row comes only from its committed migration; no code path inserts `PERMISSIONS` rows, and this update adds no permission.
8. **`tsconfig` strict flags, ESLint, Prettier, CI (`infra/**`)** — never weaken a gate to pass.
9. **Lockfiles and dependencies** — a dependency change is its own requested unit.
10. **Existing Administration routes, URLs and authz results** — byte-identical (Inv. #12).
11. **`TOREMOVE-Template-*` seed rows** — keep the prefix; no production code depends on them.
12. **The `family_offering_id` linkage convention** (`NULL` = root; non-null resolves to the root in one hop) — the two new unique indexes depend on it. Changing it corrupts every family's lineage and every index predicate.
13. **Ordering and inventory repositories, schemas and services** — this update reads one locked finder from `product_inventory` and changes nothing there. Adding that finder is the only permitted edit, and it is insert-free, read-only.

If a unit genuinely requires touching any of these, stop, explain why, and get explicit confirmation.

---

## 7. Keeping Docs in Sync

1. **Land the §9 doc amendments before or with the unit that makes them true.** `architecture.md` Inv. #18 and `prodmgmt-architecture.md` Inv. #1, #6, #13, #14, #17 land with U1; the code-standards, ui-context and workflow-rules edits land with the unit that changes the behaviour they describe. Never ship code that a doc still forbids.
2. **Clear one Appendix A row as each superseded rule stops being true in `main`.** Appendix A is temporary; a row that outlives its code is drift.
3. **Update the permission map in both places in the same change set** — `prodmgmt-architecture.md` §4 and `prodmgmt-code-standards.md` §8 — whenever a page, action or level changes. This update adds no permission but adds five actions; every one gets a row.
4. **Update the file tree in code-standards §7 as files land.** Remove a `(new)` marker when the file exists; remove a `(del)` line when the file is gone.
5. **Owning doc per fact:** product behaviour → update overview; schema, invariant or lifecycle → architecture; convention, component name or guardrail → code-standards; workflow → this doc; build history → tracker. Reference, never copy.
6. **Component names are binding.** Create exactly the names in code-standards §4.8 and §7, or the page ↔ route ↔ component ↔ permission chain breaks.
7. **A new audit event type ripples past `tsc`.** Each of the six new types needs its `AUDIT_EVENT_TYPES` entry, its `AUDIT_EVENT_CATEGORY_MAP` entry (`tsc`-caught) **and** a count/optgroup fix in `tests/components/audit-log-filters.test.tsx` (**not** `tsc`-caught). Check this explicitly; it has bitten every write unit in this module's history.
8. **Removing `PRODUCT_OFFERING_DISCARDED` is a doc change too** — update the architecture §5 event table and the filter test in the same change set as the code.
9. **Cross-module doc edits need explicit approval.** The rating-side hand-offs (H1–H3) are recorded in this update's plan, not written into `ratemgmt-*` docs by this module.

---

## 8. Verification — Before the Next Unit

Run the general doc §8 checklist in full, plus every item below. If any fails, the unit is not done.

1. **Guardrails pass** — all thirty in code-standards §9. Confirm the five re-scoped ones assert the target behaviour, not the old: 2 (DRAFT-only price mutation, trigger-backed), 8 (index-backed single-active), 11 (one-directional import rule), 13 (re-baselined schema-diff), 16 (grandfathering with `OBSOLETE`).
2. **Transitions** — every transition in Inv. #23 succeeds from its legal predecessor; every other ordered pair is refused with a typed code; no `setLifecycleStatus`-style helper exists anywhere (V1).
3. **DRAFT-only writes** — a price or spec insert, update or delete against a `TESTING`, `ACTIVE`, `OBSOLETE` or `RETIRED` parent is refused by the repository **and** by the trigger on a direct SQL write (V2).
4. **Family uniqueness** — two concurrent branch attempts leave one open version; two concurrent activations leave exactly one ACTIVE; direct SQL inserts of a second open or second ACTIVE row are rejected by the indexes, for a family root and for a branch (V3).
5. **Hard delete** — a discarded DRAFT takes its specs and prices with it, leaves siblings untouched, writes one `PRODUCT_OFFERING_DELETED` event with the removed counts, and the trigger does not block the cascade (V4, V6).
6. **Price completeness** — recurring without a period, usage without a unit, `once` with either, `'MBPS'`, `'gb'`, and an unmapped period all fail in Zod **and** at the database; seeds obey the same rules (V7).
7. **Retirement gate** — refused while a pinned subscription is not `TERMINATED` or is `TERMINATED` with `end_date >= current_date`; the refusal carries the live count; succeeds at zero.
8. **Query budget** — Manage Products' first render issues one families query plus its count and **no** per-row detail query; selecting a family issues the version, detail, specification and price queries once each; the budget still holds after a mutation (V9).
9. **Authorization** — page guard `products : EDIT`; `obsoleteOffering`, `retireOffering` and `deleteOffering` re-check `DELETE`; an EDIT-only principal is refused all three; deep links (`?family=`, `?version=`) grant nothing (V10).
10. **Audit** — exactly one `insertAuditEvent` per mutation, inside the same transaction, using a type the architecture §5 table lists; View Product reads still write nothing.
11. **Data layer** — SQL only in `db/**`; constraints enforced by the database with Zod as the mirror; no stored `end_date_time`; every status-gated decision reads on `tx`, locked.
12. **URL state** — Manage Products' list and selection state lives in searchParams, parsed and never trusted; an unknown `family` renders the empty-selection state; a `version` outside the family falls back to the primary version; neither 404s.
13. **Literal sweep clear** — no code path outside the product module treats `OBSOLETE` as unbillable or unreadable, `workflow-management/**` included (V5).
14. **Migrations** — `npm run db:migrate` on an empty database produces the five-value enum, both indexes, the trigger, the cascade FKs and every new CHECK; seeds load; no migration other than `0006` was edited.
15. **Build gates** — `tsc --noEmit`, ESLint, Prettier, full test suite, SAST and the DAST baseline clean; Orders, Subscriptions and every Administration route green and unchanged.
16. **No forbidden edits** — nothing from §6 touched without confirmation; no `app/api/product*`; no `TODO`, commented-out code or `console.*`.

---

## Appendix A — Rules in the previous version of this file that this update supersedes

Do not follow these. They are listed so you recognise them when the shipped code, its comments, or an older copy of this doc asserts them.

| Superseded rule | Rule now in force |
|---|---|
| "The price repository never gains `update*`/`delete*` — `insertPrice` is its only write, forever." | §3.7 — three writes; `updatePrice` and `deletePrice` exist and refuse any parent that is not `DRAFT` (Inv. #1, amended). |
| "Do not add a hard-delete path for offerings — every removal is a status transition (Discard/Retire), never a row deletion." | §3.8 — a `DRAFT` or `TESTING` version that was never `ACTIVE` is hard-deleted with its children; released versions are never deleted (Inv. #25). |
| "Applied migrations — forward-only; new constraints or columns ship in a new migration, never by editing an applied one." | §6.2 — still true for every migration except `0006_product.sql`, which D11 authorises editing in place, in U1, once. |
| "Single-active-per-family cannot be expressed as a unique index; enforce it transactionally." | §8.4 — two expression unique indexes on `COALESCE(family_offering_id, product_offering_id)` back the transaction lock (Inv. #13, corrected). |

`prodmgmt-code-standards.md` Appendix A lists the code comments and tests that still assert the old rules. Clear both appendices as the update lands.
