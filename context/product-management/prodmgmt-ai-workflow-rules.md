# Product Management — AI Workflow Rules (Module Supplement)

Read `context/ai-workflow-rules.md` first — it is binding for every module, applies here unchanged and in full, and this file adds **only** what Product Management changes or adds on top of it; its numbering follows that document's sections, and where a section below says nothing, the general rule is the rule and is not restated. This file governs **how you work** — gates, scope, sequence, splitting, clarifying, verifying. It does **not** own product behaviour (`prodmgmt-update-overview.md`), technical design (`prodmgmt-architecture.md`), conventions (`prodmgmt-code-standards.md`), UI wiring (`prodmgmt-ui-context.md`) or the unit list (`specs/pm00-build-plan.md`); cite those, never duplicate them.

**The active work is the Pricing Components update (pm46–pm53)** — one standardized JSON envelope per price component, discriminated on `@type`, plus **Target Capacity Commitment** and **Target Capacity Motivation**, persisted in the `product` schema and nowhere else. Authoritative decisions: **PC1–PC14**, validation invariants **VI1–VI5**, open items **O1–O10** in `_updatemodule-product-pricing-components-plan.md`.

**Three layers, never conflated.** (1) Delivered and verified: the catalog surfaces, Orders and Subscriptions through **pm34**. (2) The Manage Products rebuild **pm35–pm45 — delivery record verified false** (§0.1); every rule here that depends on the five-value lifecycle, `updatePrice`/`deletePrice`, the DRAFT-guard trigger or the expression unique indexes is the **target state, not an observed fact**. (3) The Pricing Components update: **pm46–pm49 — implemented and verified**; **pm50–pm53 — planned and gated**, not yet built.

**Companion docs (authoritative — cite them, never restate or contradict them):** `prodmgmt-update-overview.md` · `_updatemodule-product-pricing-components-plan.md` · `prodmgmt-architecture.md` (Module Invariants, incl. #30–#44 new here) · `prodmgmt-code-standards.md` (module conventions §1–§7, permission map §8, guardrails §9, Appendix A rows A1–A9) · `prodmgmt-ui-context.md` (§2, §4, §5, §7) · `specs/pm00-build-plan.md` (Part 4, units pm46–pm53) · `prodmgmt-progress-tracker.md` / `prodmgmt-completed-tracker.md`.

**Precedence:** architecture **Invariants** → `prodmgmt-update-overview.md` → `_updatemodule-product-pricing-components-plan.md` → `prodmgmt-architecture.md` → `prodmgmt-code-standards.md` → `specs/pm00-build-plan.md` → this supplement → `context/ai-workflow-rules.md`. The plan outranks architecture and code-standards **only** for facts this update introduces; for anything the shipped module already owns, architecture and code-standards win. This supplement never overrides the general doc — where it appears to, that is a bug, and §0.6 is the one place it is currently happening. On any other conflict, stop and ask.

---

## 0. Blocking Gates — Clear These Before Any Code

Six gates. Clear them in the dependency order of the table, not in section order — the numbering below is fixed because other docs cite it.

| Gate | Section | What it blocks | Status (2026-09-21) |
| --- | --- | --- | --- |
| **G-0** | §0.5 | Everything. Part 4 has no foundation without Part 3. | **OPEN — blocking** |
| **G-A** | §0.1 | Planning credibility; three docs still carry the false claim. | **Finding recorded; correction owed** |
| **G-B** | §0.2 | pm46 — any schema, repository write or service. | **OPEN — pending formal sign-off.** pm46 landed Inv. #30–#44 in force (architecture §6); that is landing the text, not G-B's sign-off. |
| **G-C** | §0.3 | pm46 — opening `0006_product.sql`. | **CLOSED** — granted 2026-09-21 (pm46 landed) |
| **G-D** | §0.4 | Unit numbering. | **CLOSED** by `pm00-build-plan.md` (2026-09-21) |
| **G-E** | §0.6 | pm46–pm49 — the planned red-tree window. | **RESOLVED (2026-09-21)** — a time-boxed suspension of §1.3/§3.7 was granted; the window widened to pm46–pm54, full-suite-green claimed once, at pm54. |

1. **G-A — Baseline reconciliation. The delivered record for pm35–pm45 is false; this is settled, not suspected.** Verified against `enterprise-billing-app/` on 2026-09-21 and recorded with its evidence table in `pm00-build-plan.md` §0: the three-value enum still stands in `0006_product.sql`, `pricing_model` and the XOR CHECK still stand in `db/schema/product.ts`, none of the six new services exist, none of the new validation schemas exist, `actions/product/` has 8 files where 15 are claimed, `db/**` has zero `OBSOLETE` matches, and `git ls-tree -r` finds the rebuild on **no** branch — not `main`, `dev1`, `dev2` or the three `claude/*`. **Do not re-run the whole sweep; do not treat the claim as open.** What remains owed is the correction itself, in the three docs that still carry it — `prodmgmt-architecture.md`'s Status line, `prodmgmt-code-standards.md` §7/§9 markers, and the trackers — recorded where found per §7.10, not silently fixed in one place. Delivering Part 3 (G-0) closes this by making the claim true instead.
2. **G-B — Invariant amendments approved and recorded.** Architecture §6 Inv. **#2**, **#4**, **#5** and **#28** are each contradicted by PC8 and PC14, and §3.1's "Tier storage — JSONB" row goes with them (Appendix A8). An Invariant change requires a documented design review. Until the user records that approval, write no schema, no repository write and no service for this update. Architecture §6 states the amendments are **proposed, not yet approved** — do not read their presence in the doc as approval.
3. **G-C — Fresh, written authorization to edit `0006_product.sql` in place.** §6.2 closed the D11 one-round exception at pm45 and restored forward-only. PC14 needs a second in-place edit and that authorization **does not exist**. Do not open the file until the user grants it in writing, and **do not substitute a forward migration on your own initiative** — the choice between the two is the user's, not a detail you may settle. If the fresh-install assumption is withdrawn, the create-new-type-and-swap form (architecture §3.4) is the only correct shape and pm46's unit text changes accordingly.
4. **G-D — Unit numbers assigned. CLOSED.** `pm00-build-plan.md` Part 4 authorises **pm46–pm53**. From here cite pm-numbers — never the retired PU1–PU6 labels — in commits, specs and gates (§2.3).
5. **G-0 — Part 3 live in `main`. NEW, and it blocks hardest.** pm35–pm45 must be built, merged and ship-gate-verified before pm46 opens. Part 4 depends on it at four points: PC14 reshapes a table whose CHECKs and cascade FKs **pm35** writes; the DRAFT-only write path reuses **pm36**'s trigger and **pm38**'s service guard and its `updatePrice`/`deletePrice`; the authoring UI extends **pm41**'s editable panel inside **pm40**'s shell. **Do not start pm46 by rebuilding a subset of Part 3 inside it.** That silently re-plans eleven specified units inside one, and the correct response is to build Part 3 as written.
6. **G-E — The planned red-tree window contradicts the general doc. Resolve it before pm46, do not absorb it.** `pm00-build-plan.md` Part 4 states plainly that `db:seed` is red from pm46 until **pm48**, and that `tsc --noEmit`, ESLint and the full test suite are red from pm46 until **pm49**. General doc §1.3 says *"Never commit a unit that breaks the build"* and §3.7 says *"A step would leave the tree red — re-cut boundaries so every step is independently green."* This supplement cannot grant that exception; the general doc outranks it. The cause is real and is not a planning failure — PC14's column drops break code and fixtures that cannot compile against the old shape and the new one at once (architecture §3.7) — but the resolution is the user's, and it is one of exactly three:
   - **squash pm46–pm49 into one atomic commit** that is green at its boundary (the units stay separate for review, the tree is never committed red);
   - **grant an explicit, recorded, time-boxed suspension** of §1.3 and §3.7 for pm46–pm49, naming the window and the unit that closes it;
   - **re-cut the boundaries** so each unit lands green, which means additive-then-subtractive DDL and is incompatible with PC14's clean in-place reshape.
     Present these three, get one chosen, record it here with the date. Until then, **do not begin pm46** on the assumption that a red tree is acceptable because a plan document says so.

---

## 1. Operating Approach

1. **Read the companion docs in full before writing a line of code.** They describe a shipped baseline, a rebuild whose delivery record was false, and an agreed change on top of both. Do not infer the current shape from the code alone, and do not infer it from the docs alone — this module has already been burned once by each.
2. **Cite the authorizing section before coding.** Name the decision (PC1–PC14), the validation invariant (VI1–VI5), the Module Invariant (#30–#44 are this update's), the code-standards rule, or the pm-unit that mandates what you are about to build. No citation, no mandate — stop and ask.
3. **Build strictly in pm-order: pm46 → pm47 → pm48 → pm49 → pm50 → pm51 → pm52 → pm53.** Part 4 is a straight chain with no parallelism, because PC14 reshapes the one column every later unit reads or writes. Do not reorder, do not overlap, and do not start a unit whose predecessor is not committed and verified.
4. **Treat the envelope as the only price shape** once pm47 lands (code-standards §1.21). A code path that reads a price shape from a column, a `pricing_model` string or a `tiers[]` array is a defect, not a legacy allowance.
5. **Make the smallest correct change.** No refactor, rename, folder reorg or dependency change rides along with a unit.
6. **State the unit's scope, files, permissions and tests before editing**, and stop and re-scope the moment you touch a file that is not on that list.

### Permanent rules — they never expire, in any unit, in any future phase

Review-blocking defects on sight. The pricing update's own prohibitions live in code-standards §1.21–§1.34 and architecture Inv. #30–#44; these are the ones that outlive any single update.

- Never create `app/api/product*`, `app/api/ordering*` or `app/api/inventory*`.
- Never make `is_bundle` user-settable, in any schema, form or dialog.
- Never mutate an `ACTIVE` offering, its specifications or its prices in place — branch first via `branchOfferingAsDraft` (Inv. #14).
- Never read a status that gates a branch-or-write decision before the transaction opens. Read it on `tx`, locked, immediately before the decision. This exact TOCTOU bug was found and fixed four times (pm14, pm15, pm16, pm20). It now also covers the offering-level component validator, which reads sibling rows on `tx` after the lock.
- Never add `update*` or `delete*` to the `order_item_price_override` or `inventory_status_history` repositories (Inv. #16, #18, #39).
- Never add a column matching `%cycle%` or `%frequency%` to `ordering.*` or `inventory.*` (Inv. #20).
- Never weaken order approval: it re-runs the full submission validation under locks and refuses reviewer = submitter, in the service and at the DB CHECK.
- Never add a migration or backfill that repoints a subscription's `product_offering_id`. Grandfathering is unconditional (Inv. #17).
- Never reshape `ordering.order_item_price_override`. One row per `(order_item, price_type)`, insert-only, scalar `amount` + `currency` (Inv. #16, #39, PC9).
- Never conflate the envelope's `priceType` with a `price_type` column, and never reintroduce `price_type` on `product_offering_price` under any name (PC13, Inv. #38).
- Never write into `enterprise-billing-app/` when the task is planning. Plans, specs and doc updates go to `_plan_enterprise-billing-app/`.

---

## 2. Units — One at a Time

1. **The unit list is `pm00-build-plan.md` Part 4 — pm46 through pm53. Build exactly those, in that order, each verified and committed before the next starts.** Do not re-derive the list here and do not invent a unit. Each Part 4 row states its builds, its visible result and its dependencies; that row is the unit's contract.
2. **Land each unit's tests in the same commit as its behaviour.** Deferring guardrail coverage to the ship gate repeats the pm24 finding, where guardrails 8, 9 and 14 went unverified for several units. This is why the composition-contract test lands in pm47 with the definitions it proves, not in pm53.
3. **Cite pm-numbers, never the PU labels.** G-D is closed and the conceptual PU1–PU6 buckets are **superseded** by Part 4. Their mapping is recorded in `pm00-build-plan.md` §Sequencing notes (Part 4) for historical reading only: PU1→pm46, PU2→pm47, PU3+PU4→pm49 merged, PU5→pm50+pm51+pm52 split, PU6→pm48 pulled forward plus parts of pm47 plus pm53.
4. **Do not re-litigate Part 4's four documented deviations from the PU buckets.** Each was argued in writing and is settled: PU3 merges into pm49 (a repository with no caller has no visible result, and the split that matters — per-row VI1/VI2 in pm47 versus cross-row VI3–VI5 in pm49 — is preserved); seeds move forward to pm48 (the demo seed stops compiling the moment pm46 drops the columns, and every later unit needs a seeded four-component offering to be demonstrable); the composition test lands in pm47; the tiered sweep lands in pm47 unless it turns up more than a handful of surviving sites, in which case §4.4 applies and it splits out before pm47's union. Reopening a settled deviation is scope creep in planning clothing.
5. **Split any unit that grows past its Part 4 row.** Finish the smaller piece first, and record the split in `pm00-build-plan.md` rather than leaving it implicit in the commit history.

---

## 3. Scoping — No Speculative Changes

Apply the general doc §2 in full, plus these. The numbering is fixed; other docs cite §3.1, §3.2, §3.5, §3.10–§3.12 and §3.15 directly.

1. **Do not build anything in the update overview's _Out of Scope_ list.** The bill-run computation (the capacity resolver, the `customer_bill_line` mapping, proration, rounding, the BAN aggregation grain); the rating engine's rate extraction (`rp.py`) and any `PER_UNIT` or rate-card `udr_rate_detail` variant; the LookUp Rate Card table; any TMF620 API or adapter; reshaping the negotiated override; the `once` → `oneTime` rename on `ordering.order_item_price_override` (O2).
2. **This update has no cross-module reach — not even a read — with exactly one flagged exception that must be authorized before pm46 lands.** No unit reads or writes `ordering/**`, `inventory/**`, `billing/**` or `rating/**`; a unit that finds itself doing so is out of bounds and must stop. **The exception is a live doc-vs-doc conflict, not a permission:** `services/ordering/order-preconditions.ts:95` resolves an override target with `price.priceType === override.priceType && price.pricingModel === "flat"`, and both properties vanish when pm46 drops the columns — so `tsc` breaks in a folder this rule forbids. Architecture §3.7 says that line ships with this update; this section and §6.5 say it must not be touched. **Stop and get the re-key authorized as its own step. Do not edit `ordering/**` silently, do not leave a compatibility shim, and do not close the conflict by editing one of the two docs.** Tracked as code-standards Appendix A9.
3. **Do not add a fourth table to the `product` schema**, and do not add a column the current unit does not need — no stored `end_date_time`, no `last_update`, no derived "is billable" column, no second version-like counter, no `sequence`.
4. **Do not fetch per-row detail on a list page**, in any form: no `getOfferingDetail` in a loop, no `Promise.all` over rows, no concurrency-limited mapper. If a list needs a field, add it to the paged SQL. Guardrail 29's query budget must still hold after a component write.
5. **Do not add a fourth write to the price repository.** `insertPrice`, `updatePrice`, `deletePrice` — and the latter two refuse a parent that is not `DRAFT`.
6. **Do not fork a shared primitive.** One action folder, one nav registry, one set of Administration table primitives, one money formatter, one datetime formatter, one badge per domain union. Extend; never copy.
7. **Do not disable, weaken or delete a guardrail to make a unit pass.** Re-baseline 13 and re-scope 27 as pm46 and pm53 require; land 31–34; every other guardrail passes as written.
8. **Do not add a sixth component type or a ninth envelope field** (code-standards §1.32). The envelope is closed at eight fields and five types. A sixth type is a new phase, not a unit.
9. **Do not add a `sequence` field.** PC12 fixes apply order canonically by stage then class — quantity transforms before rate schedules. The omission is considered, not a gap.
10. **Do not implement the bill run.** The composition contract exists so a **test-local pure function** can assert the worked figures (code-standards §2.17). Do not wire it to `customer_bill_line`, a bill-run service, a resolver, or anything that executes in production, and do not export it from the test file.
11. **Do not build rate-card resolution.** `rateCardLookUp` is persisted and validated as a **name only** — no FK, no join, no table, no lookup, no fallback logic. Record PC10's precedence in the schema doc-block and stop there.
12. **Do not build a TMF620 adapter, mapper, serializer, SDK binding, DTO or `toTmf620()`.** The mapping is a documentation table in `pricing-component.schema.ts`; one `plaSpec` doc-block per `@type` is the deliverable.
13. **Do not write a backfill, a data-fix script, a relabelling migration or a dual-read compatibility shim.** PC14 runs under fresh install: the old shape is deleted, not migrated. Their absence is a success criterion, not an omission.
14. **Do not keep `tiered` alive anywhere**, and do not re-express it as a generic tier helper, a `steps` alias or a deprecated export (PC8, Inv. #41).
15. **Do not add an audit event type.** Component writes reuse `PRODUCT_PRICE_ADDED`, `PRODUCT_PRICE_UPDATED` and `PRODUCT_PRICE_DELETED`; only their before/after payloads change. If a unit believes it needs a new type, stop and ask — and if one is approved, §7.4's ripple checklist applies in full.
16. **Do not add a permission, a level, a page, a route, a segment or a search param.** Authoring components is `products : EDIT` on `/products/manage-products`; viewing them is `products : READ`; the existing `DELETE` split is untouched. If a unit finds itself creating one, it has left scope.

---

## 4. When to Split

Apply the general doc §3, plus these. §4.2–§4.5 are cited by `pm00-build-plan.md`.

1. **Split the schema from everything that depends on it.** pm46 lands and is verified alone, against a database built from empty.
2. **Keep the per-row union and the cross-row validator in different units.** VI1 and VI2 validate one component and belong in pm47; VI3, VI4 and VI5 read the offering's *other* rows and belong in pm49, inside the transaction, after the DRAFT lock. This is the split that preserves **which layer refused a write** — it survives the PU3/PU4 merge and must not be collapsed further.
3. **Split the capacity components' authoring UI from the plain components'.** `capacity_motivation`'s repeating ascending `steps[]` editor is the largest single piece in the update; it is why pm52 exists separately from pm51. Split further if the panel diff stops being explainable in a few sentences.
4. **Split the tiered-removal sweep from the behaviour change** if it turns up more than a handful of sites once pm46 lands, and land the sweep before pm47's union. Guardrail 31 asserts the end state either way.
5. **Keep seeds attributable.** A seed failure must be traceable to the seed, not to the schema that landed with it — which is why pm48 is its own unit after pm46, and why merging seeds *into* the schema unit is declined here even though pm35 did it.
6. **When in doubt, split.**

---

## 5. Missing or Ambiguous Requirements

1. **Never guess on security, permissions, data shape, effectivity, versioning, lifecycle transitions or audit.** Stop and ask one precise question with options.
2. **Stop and ask on these named open items — do not resolve them yourself.** Seven of the ten belong to a later phase; implementing one because a test would be easier is a scope breach.
   - **O1** — base-rate semantics when `rateCardLookUp` varies the per-unit rate across UDRs. Owner: bill-run phase.
   - **O2** — the `once` → `oneTime` rename on `ordering.order_item_price_override`. Deferred; this update does not touch that table. Two vocabularies coexist until it lands, which is exactly why Inv. #38 exists.
   - **O5** — effectivity-aware binding resolution when dated successor `usage_rate` rows exist for one unit. Owner: bill-run/resolution phase. **This one bites pm49:** VI4 is validated **at the instant being validated**, and you must not invent a period-wide resolution rule to close the dated-successor case.
   - **O6** — whether an order-item `negotiated_override` becomes the base rate the capacity modifiers compute against. Owner: bill-run phase.
   - **O7** — the BAN-level aggregation grain for the commitment floor. Owner: bill-run phase.
   - **O8** — proration of `committedQuantity` for a mid-period start, stop or suspension. Owner: bill-run phase.
   - **O9** — rounding policy for the combined charge. Owner: bill-run phase.
     **O3 and O4 are resolved** (PC14, Option A). **O10 is this module's** and is a pm52 deliverable, not a question.
3. **Stop and ask on these three unresolved conflicts between companion docs. Do not close any of them by editing one side.**
   - **The rekeyed unique index's NULL form.** Architecture §3.4 flags the `unit_of_measure`-is-NULL collision as **unresolved**, proposes an expression index on `COALESCE(unit_of_measure, '')`, and says to confirm before the DDL is written; architecture §7 repeats it as an open gap. `pm00-build-plan.md` pm46 and code-standards guardrail 13 both specify **`NULLS NOT DISTINCT`**. Both close the hole; they are different DDL and different guardrail text. Get one chosen before pm46's DDL is written, then make §6.14, architecture §3.4/§7, pm46 and guardrail 13 agree in the same change set. Do not use a sentinel string either way.
   - **`order-preconditions.ts` ownership** — §3.2.
   - **The red-tree window** — §0.6.
4. **Never invent a JSONB shape, a `plaSpecId`, a `priceType` value or a violation code.** They are all fixed and all owned elsewhere: the envelope and its branches in `pricing-component.schema.ts` (PC11), the literals in code-standards §2.12 and §5.4–§5.5, the three `OfferingComponentViolation` codes in code-standards §2.14. If the plan does not show a field, it does not exist.
5. **Never guess price effectivity or backdating.** End is derived from the successor's `start_date_time`, computed **per `(component_type, unit_of_measure)` lane**; a future-dated successor does not displace the current price early; the tolerance is exactly 3 days, checked against the transaction's `now()`.
6. **Never guess versioning or lifecycle semantics.** `version` is a family-relative sequence number assigned once; `family_offering_id` resolves to the root in exactly one hop; `TESTING` is read-only, not orderable, not billable, reversible to `DRAFT`, and counts as the family's open version — nothing more.
7. **Stop and ask if a unit appears to need an exception** to branch-on-edit, to the DRAFT-only write rule, or to the delete rule. It almost certainly means a primitive is being bypassed.
8. **Record every resolution in the owning companion doc** in the same change set, so the next agent does not re-ask.

---

## 6. Files You Must Not Modify Without Explicit Instruction

The general doc §5 list applies in full. Module-specific:

1. **`components/ui/`** — managed vendor layer. Compose new components in `components/products/` or `components/products/manage/`.
2. **`db/migrations/0006_product.sql`** — **locked.** The D11 one-round in-place exception closed at pm45 and forward-only is the rule. PC14 needs a second round and that authorization does not exist (gate G-C, §0.3). Never edit any other applied migration.
3. **Never write a migration that adds an enum value and then uses it.** The migrator applies all pending files in one transaction and Postgres rejects the use (`unsafe use of new value`, verified on PG 16.13). If a forward migration replaces the in-place edit, create-new-type-and-swap is the only correct shape.
4. **View Product's files** — the route folder `app/(app)/products/product-offering/` and the presentational components `components/products/*.tsx`. The route folder may be touched only for nav label or page `H1` text. You may **import** `components/products/*` from `components/products/manage/**`; you may not edit those files to suit Manage Products (Inv. #29). **`prices-panel.tsx` is the trap in this update** — it renders the dropped shape and it is View Product's, not Manage's, so rendering components needs a change it cannot absorb read-only. It is raised as its own unit, **pm50**, and must not be absorbed into the authoring UI.
5. **`ordering/**` and `inventory/**`** — schemas, repositories, services, validation and components. Untouched by this update, in every unit, subject only to the flagged and unresolved `order-preconditions.ts` conflict of §3.2, which is a stop-and-ask, not a licence.
6. **`rating/**`, `billing/**` and `workflow-management/**`** — read-only from this module, and this update reads nothing from them. The rate card, RP's extraction and the capacity resolver live there and are later phases. **Their SQL breaks when pm46 drops the columns** (architecture §3.7) — report it, do not fix it here, and do not let a red rating or bill-run flow pull you across the boundary.
7. **Better-Auth managed tables and the `auth/` field mapping** — this module only FKs `core.APPUSER`.
8. **The permission registry mechanism** — the `products` row comes only from its committed migration; no code path inserts `PERMISSIONS` rows, and this update adds no permission.
9. **`tsconfig` strict flags, ESLint, Prettier, CI (`infra/**`)** — never weaken a gate to pass. A red tree is resolved by §0.6, never by relaxing a gate.
10. **Existing Administration routes, URLs and authz results** — byte-identical (Inv. #12).
11. **`TOREMOVE-Template-*` seed rows** — keep the prefix; no production code depends on them.
12. **The `family_offering_id` linkage convention** (`NULL` = root; non-null resolves to the root in one hop) — the two expression unique indexes depend on it.
13. **`db/bootstrap/rating-db-roles.sql` and `db/bootstrap/billrun-db-roles.sql`** — no change is needed and none may be made. Grants are table-level `SELECT`, so the two new columns are readable without a bootstrap edit; the reshape is grant-transparent. A unit that finds itself editing a bootstrap role file has misdiagnosed a reader break as a permission problem.
14. **The uniqueness index on `product_offering_price` — rekey it exactly once, in pm46, and only after §5.3's first conflict is resolved.** `product_offering_price_type_start_unique` (`product_offering_id, price_type, start_date_time`) becomes `(product_offering_id, component_type, unit_of_measure, start_date_time)`. `unit_of_measure` is **NULL for `flat_fee`** and NULLs do not collide in a plain UNIQUE, so without a chosen NULL treatment two identical `flat_fee` rows sharing a `start_date_time` both insert and VI4 silently does not hold. The module has hit this before and closed it with `NULLS NOT DISTINCT` in `0013_gl_mapping_nulls_not_distinct.sql`, and closed the analogous root-row case with a `COALESCE` expression index on `product_offering`; both precedents exist, which is why the docs disagree. Never solve it with a sentinel string.

If a unit genuinely requires touching any of these, stop, explain why, and get explicit confirmation.

---

## 7. Keeping Docs in Sync

1. **Land the doc amendment before or with the unit that makes it true.** The Inv. #2/#4/#5/#28 and §3.1 amendments land with **pm46**; the code-standards §7 file-tree and §9 guardrail edits land with pm53; the ui-context rekeys land with the unit that renders them. Never ship code that a doc still forbids.
2. **Clear an Appendix A row only by grep, never from memory.** Rows A1–A9 live in `prodmgmt-code-standards.md` Appendix A with their clearing units; this file's Appendix A carries only the workflow-specific ones. A row that outlives its code is drift.
3. **`pricing-component.schema.ts`'s doc-block is a shipped deliverable, not a comment.** One `plaSpec` description per `@type` plus the TMF620 mapping table, cross-linked from the module `AGENTS.md` and `README.md` (PC11). A unit that lands the union without it is incomplete.
4. **A new audit event type ripples past `tsc`.** This update expects **none** (§3.15). If one is nonetheless approved it needs its `AUDIT_EVENT_TYPES` entry, its `AUDIT_EVENT_CATEGORY_MAP` entry (`tsc`-caught) **and** a count/optgroup fix in `tests/components/audit-log-filters.test.tsx` (**not** `tsc`-caught). This has bitten every write unit in this module's history.
5. **Confirm the permission map explicitly and say so.** This update changes no row in architecture §4 or code-standards §8. State that at the pm53 gate rather than leaving it unexamined — an unexamined authz surface is the one thing a reviewer cannot infer from a green suite.
6. **Update the file tree in code-standards §7 as files land.** Add `pricing-component.schema.ts`; remove `pricing-characteristics.schema.ts` and its test when they are gone.
7. **Owning doc per fact:** product behaviour → `prodmgmt-update-overview.md`; the envelope, a `plaSpec`, the TMF620 mapping or a composition figure → the plan and the schema doc-block; schema, invariant or lifecycle → `prodmgmt-architecture.md`; convention, type, component name or guardrail → `prodmgmt-code-standards.md`; token or rendering → `prodmgmt-ui-context.md`; units → `pm00-build-plan.md`; workflow → this doc; build history → the trackers. Reference, never copy.
8. **Component and code names are binding.** `PricingComponentBadge`, `validateOfferingComponents`, the three `OfferingComponentViolation` codes, the `plaSpecId` literals — create exactly the names the code-standards define, because the UI copy and the tests key off them.
9. **Cross-module doc edits need explicit approval.** The rating-side and bill-run-side consequences (O1, O5–O9, and the reader breaks in architecture §3.7) are recorded in this module's plan, not written into `ratemgmt-*` or `billmgmt-*` docs by this module.
10. **Record every doc/code disagreement where you find it, in every doc that carries it.** §0.1 exists because one went unrecorded for a whole update cycle, and G-A is still open only because the correction is owed in three more places. Correcting one copy and moving on is how the original defect was created.

---

## 8. Verification — Before the Next Unit

Run the general doc §8 checklist in full, plus every item below. If any fails, the unit is not done. The full guardrail set and its wording live in code-standards §9 — this is the run list, not a second copy.

1. **Guardrails pass.** All 1–30 as written, plus this update's own, each of which must be **landed, not assumed**: **13** re-baselined to the reshaped table (both new columns, the per-`component_type` CHECK, the rekeyed index in whichever form §5.3 resolves to, and the absence of the four dropped columns); **27** re-keyed from `price_type` to `component_type`; **2** and **16** carried over with component fixtures; and the four new ones — **31** tiered is gone (grep-asserted), **32** envelope strictness (unknown key rejected in Zod **and** refused by the DB CHECK independently), **33** cross-component validity (VI3, VI4, VI5 each refused at the write boundary with its typed code), **34** the override untouched.
2. **Composition contract.** The pure-function test reproduces `800 EA → 100,000`, `2000 EA → 150,000`, `3000 EA → 175,000` with the second `@25` band, plus the commitment-exceeds-first-step case. It stays test-local and exports nothing to production.
3. **DRAFT-only writes.** A component insert, update or delete against a `TESTING`, `ACTIVE`, `OBSOLETE` or `RETIRED` parent is refused by the repository **and** by the pm36 trigger on a direct SQL write.
4. **Uniqueness.** Two `flat_fee` rows with a NULL `unit_of_measure` and the same `start_date_time` on one offering are rejected; dated successors for one `(component_type, unit)` still insert.
5. **Migrations.** `npm run db:migrate` on an **empty** database produces the reshaped table, the per-`component_type` CHECK and the rekeyed index; the four dropped columns do not exist; seeds load; **no backfill or data-fix script exists anywhere in the result** — assert its absence, do not merely refrain from writing one.
6. **Seeds.** All three sets emit envelopes and are held to the same Zod union and the same CHECKs as user input; a deliberately malformed seed fails twice — at Zod before insert, and at the CHECK if Zod is bypassed.
7. **Row/envelope agreement.** `component_type` equals `price_component ->> '@type'` on every row (Inv. #30); `specVersion` is present on every stored envelope (Inv. #44); `negotiated_override` cannot be inserted into `product_offering_price` (Inv. #39).
8. **UI.** The four authorable types can be added, edited and deleted inline on a `DRAFT`; the same version at `TESTING` renders read-only with no disabled controls; VI3–VI5 refusals render as the panel-level **blocking** banner from the server result, never as a client pre-check; the not-yet-billable warnings show and **do not block save**; raw `@type` and the derived envelope fields are never surfaced.
9. **Audit.** Exactly one event per mutation, in the same transaction, using one of the three existing price types; no new type was added (§3.15); View Product reads still write nothing.
10. **Authorization.** Page guards unchanged; no new permission, level, route or search param; the permission map changes no row and pm53 says so (§7.5).
11. **Data layer.** SQL only in `db/**`; the database enforces, Zod mirrors; no stored `end_date_time`; every status-gated decision reads on `tx`, locked; the cross-row validator takes `tx` as its first argument so it cannot run outside a transaction.
12. **Query budget.** Manage Products' first render still issues one families query plus its count and **no** per-row detail query; selecting a family still issues four queries; the budget holds after a component write.
13. **Cross-runtime readers reported, not fixed.** Confirm you have re-checked the reader inventory in architecture §3.7 — `rp.py`, `bill_run_processing.template.yml`, `order-preconditions.ts`, `create-order.schema.ts` — and the fixture blast radius across the rating, bill-run and ordering suites, `ship-gate-guardrails` and `seed-billrun-sample.ts`. **That inventory is the checklist, not this module's file list.** Report the state of each; fix none of them here without the §3.2 authorization.
14. **Documentation deliverables.** Every `@type` has its `plaSpec` doc-block; the TMF620 mapping table exists in `pricing-component.schema.ts`; both are cross-linked from `AGENTS.md` and `README.md`.
15. **Build gates.** `tsc --noEmit`, ESLint, Prettier, the full test suite, SAST and the DAST baseline clean; Orders, Subscriptions, View Product and every Administration route green and unchanged. **If this item cannot pass because the unit sits inside the pm46–pm49 window, that is gate G-E (§0.6), not a waiver** — do not commit red on the strength of a plan document.
16. **No forbidden edits.** Nothing from §6 touched without confirmation; `0006_product.sql` untouched unless G-C was granted; no `app/api/product*`; no `TODO`, commented-out code or `console.*`.

---

## Appendix A — Workflow rules superseded by the Pricing Components update

The full superseded-rule register is `prodmgmt-code-standards.md` Appendix A, rows **A1–A9** — read it there; it is not duplicated here. Only the rows whose subject is a **workflow rule in this file** are tracked below. Clear a row by grep, never from memory.

| #   | Superseded rule (this file, still in force today)                                                                             | Replaced by                                                                                                                             | Clears with |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| W1  | §6.2 — forward-only migrations; `0006_product.sql` is locked (closed at pm45).                                                  | Still in force. Clears **only** if the user grants the fresh authorization of gate G-C, and this row then records that grant and its date. | gate G-C    |
| W2  | §2's conceptual PU1–PU6 buckets as the unit list.                                                                               | `pm00-build-plan.md` Part 4, units pm46–pm53. **Cleared 2026-09-21** — retained for one cycle so stale PU references resolve.             | cleared     |
| W3  | §1.3/§3.7 of the **general** doc — every unit lands green — as applied to pm46–pm49.                                            | Unresolved. One of G-E's three options, chosen and recorded by the user (§0.6).                                                            | gate G-E    |
| W4  | §3.2 — no cross-module reach at all, as applied to `services/ordering/order-preconditions.ts:95`.                               | Unresolved doc-vs-doc conflict with architecture §3.7; needs its own authorized step (code-standards Appendix A9).                        | that step   |

**Unresolved, tracked here because it has no other home:** the pm35–pm45 delivery record is **verified false** (§0.1, evidence in `pm00-build-plan.md` §0). `prodmgmt-architecture.md`'s Status line, `prodmgmt-code-standards.md` §7/§9 and the trackers still carry the false claim. Until each is corrected in place, treat every "delivered" claim about the Manage rebuild in those documents as unverified, and do not cite any of them as evidence that Part 3 shipped.
