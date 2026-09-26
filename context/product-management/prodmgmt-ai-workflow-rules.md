# Product Management — AI Workflow Rules (Module Supplement)

Read `context/ai-workflow-rules.md` first — it is binding for every module, applies here **unchanged and in full**, and this file adds only what Product Management changes or adds on top of it; the numbering below follows that document's sections, and where a section says nothing, the general rule is the rule and is not restated. This file governs **how you work** — gates, scope, sequence, splitting, clarifying, verifying. It does **not** own product behaviour (`prodmgmt-update-overview.md`), technical design (`prodmgmt-architecture.md`), conventions (`prodmgmt-code-standards.md`), UI wiring (`prodmgmt-ui-context.md`) or the unit list (`specs/pm00-build-plan.md`). Cite those; never duplicate them.

**The active work is the Rate Card Lookup update** (`product.ratecard_version`, `product.RATECARD_RAN_USAGE_LKP`, `/products/rate-card`). Authoritative decisions (the RC-series, as revised), invariants **RV1–RV3** (RV4 withdrawn by D-A8; RV9 removed by D-A7) and open items **OR3 / OR4 / OR-RET** (OR7′ resolved 2026-09-25) live in `_updatemodule-ratecard-lookup-plan-v2.md`; the Module Invariants it introduces are **#45–#60** in `prodmgmt-architecture.md` §6 (several withdrawn or removed in place under v2). **This update stands up the lookup table and its upload/diff/activate/rollback lifecycle and its UI, and stops.** There is no carry-forward (D-A7): a version is exactly its uploaded file. Nothing consumes the table: the rating engine's resolution of a UDR against the lookup — the `rp.py` card join, `RATECARD_LOOKUP_MISS`, the `udr_rated` stamps, drift detection — is a **following-sprint** deliverable, owned by Rating Management (`rm`-series), and you build none of it (§3.14).

**This update sits alongside the Pricing Components update (pm46–pm56); it does not supersede it, and — making no change to `product_offering_price` — it carries no dependency on the pricing branch.** Everything the pricing update specifies stays in force. Read the previous revision of this file at commit `4328b85` if you need the pricing update's workflow rules in their original form; the ones that outlive it are carried into §1 and §6 below, and the rest are in Appendix A.

**Companion docs (authoritative — cite them, never restate or contradict them):** `_updatemodule-ratecard-lookup-plan-v2.md` · `prodmgmt-update-overview.md` · `prodmgmt-architecture.md` (Module Invariants, **#45–#60** new here) · `prodmgmt-code-standards.md` (module rules §1.35–§1.48, §2.19–§2.28, §3.15–§3.23, §4.22–§4.31, §6.23–§6.38, §7.8–§7.12; permission map §8; guardrails 35–40 §9; Appendix A rows **A10–A14**) · `prodmgmt-ui-context.md` · `specs/pm00-build-plan.md` (Part 4, pm46–pm56) · `_updatemodule-product-pricing-components-plan.md` (PC10).

**Precedence.** Architecture **Invariants** → `_updatemodule-ratecard-lookup-plan-v2.md` → `prodmgmt-update-overview.md` → `prodmgmt-architecture.md` → `prodmgmt-code-standards.md` → `specs/pm00-build-plan.md` → this supplement → `context/ai-workflow-rules.md`. The rate-card plan outranks architecture and code-standards **only** for facts this update introduces; for anything the shipped module already owns, architecture and code-standards win. This supplement never overrides the general doc. On any other conflict, stop and ask.

---

## 0. Verified tree state — read this before you trust any status line

**Verify the tree; do not quote a doc's status block.** This module has been burned by a false delivery record once already, and three companion docs currently carry status text that the working tree contradicts. The facts below were verified directly in `enterprise-billing-app/` on **2026-09-23**. Re-verify each one before you rely on it; do not re-verify the whole sweep.

| Fact | Evidence | Consequence for you |
| --- | --- | --- |
| Branch `dev1` is at `cb28f64`; **pm50 and pm51 are landed** | `git log` | The pricing branch is real and inside the **G-E atomic window**, which closes at **pm54**. Part 3 and pm46–pm49 are live. |
| `0006_product.sql` contains `component_type` (10 occurrences) | `db/migrations/0006_product.sql` | **Gate G-C was granted and consumed by pm46.** It does **not** extend here (RC12). `0006` is locked again (§6.3). |
| Latest migration on disk is `0040_product_family_guards.sql` | `db/migrations/` | `0041_ratecard_ran_usage_lkp.sql` is free. Claim the number when you write the file, not before; if another update lands `0041` first, renumber yours and fix every citation in the same change set. |
| `types/rbac.ts` lists **14** `PERMISSION_NAMES` | `types/rbac.ts:1-17` | Adding `ratecard` makes **15**. `prodmgmt-architecture.md` §1 says "15, and this makes it 16" and is **wrong**; code-standards §8 is right. Correct architecture §1 in the change set that adds the name (§7.6). |
| `next.config.ts` has **no** `experimental` key | `next.config.ts` | The `bodySizeLimit` raise adds one (RC15, code-standards §6.38). It is a platform-owned file — §6.9. |
| No rate-card artifact exists anywhere — no table, no schema, no service, no action, no component, no permission | swept `db/`, `services/`, `actions/`, `app/`, `validation/`, `types/`, `lib/`, `components/` | Nothing in this update is built. Every rule below describes target state. |
| `rateCardLookUp` exists as a **validated name only** — no FK, no join, no lookup | `validation/product/pricing-component.schema.ts` | This update is what puts something on the other end of the name (Inv. #42, Appendix A row A10). |

**Two docs carry status text the tree contradicts. Record the disagreement where you find it (§7.10); do not silently fix one copy.** `prodmgmt-code-standards.md`'s Status block still calls pm35–pm45 "delivery unverified" and the pricing update "PLANNED, gated on G-0 and G-C" — both were overtaken by the `dev1` history above. `prodmgmt-architecture.md` §1 carries the wrong permission count.

---

## 0.1 Blocking gates — clear these before any code

Three gates. Clear them in the order of the table. The numbering is fixed because other docs will cite it; **G-RC2 and G-RC5 are withdrawn under v2** (this update makes no `product_offering_price` change and no `rp.py` amend) and are retained as struck rows only so the numbering resolves.

| Gate | Section | What it blocks | Status (2026-09-24) |
| --- | --- | --- | --- |
| **G-RC1** | §0.2 | **Everything.** No unit numbers exist. | **OPEN — blocking** |
| ~~**G-RC2**~~ | — | ~~The merge point (OR11).~~ | **WITHDRAWN — v2 touches no shared pricing branch code** |
| **G-RC3** | §0.4 | The migration's `PERMISSIONS` row, `types/rbac.ts`, nav, authz matrix (OR3). | **OPEN — recommendation only** |
| **G-RC4** | §0.5 | `parse-csv.ts` and the dependency add (OR4). | **OPEN** |
| ~~**G-RC5**~~ | — | ~~The third `lead()` partition site — now shipped code.~~ | **WITHDRAWN — v2 makes no `rp.py` amend** |

1. **G-RC1 — this update has no authorised unit numbers. Get Part 5 written before you write code.** `pm00-build-plan.md` Part 4 authorises **pm46–pm56** and stops there; there is no Part 5 and no spec file for any rate-card unit. Code-standards §7 already marks the rate-card file tree *"unit numbers unassigned; pm00-build-plan.md stops at pm56."* **Do not invent a unit number, do not reuse a pm4x number, and do not build the update as one undifferentiated change because no list exists.** Propose the unit breakdown of §0.2 to the user, get it recorded in `pm00-build-plan.md` as Part 5 with its own gates and per-unit specs, then build from that list. Until it exists, the only work authorised here is planning.
2. **G-RC3 — Get the permission name decided (OR3).** `ratecard` as a new `PERMISSION_NAMES` member, or reuse `products : EDIT`. Architecture §4 and code-standards §8 are both written on the **recommendation**, not on a decision. Write no `PERMISSIONS` seed row, no `types/rbac.ts` edit, no `NAV_REGISTRY` entry and no authz-matrix row until it is decided. **If it reverses to reusing `products`, rewrite the reasoning paragraphs in architecture §4 and code-standards §8 — do not delete them.**
3. **G-RC4 — Get the file format and parser pinned (OR4).** CSV is recommended; no library is chosen and `package.json` has none. This is the update's **only new runtime dependency**, and a dependency change is its own requested unit under general §5.6. Pin it explicitly, with type coercion off, before `parse-csv.ts` is written.

---

## 0.2 The unit breakdown to propose under G-RC1

Propose exactly this cut — **twelve units** (pm57, pm60–pm68, pm70, pm71) — in this order, one unit per pass. Do not merge two rows. Do not start a row whose predecessor is not committed and verified. **pm58, pm59 and pm69 are withdrawn under v2** — pm58/pm59 were the `product_offering_price` partition amend and `AMBIGUOUS_RATE_CARD`, and pm69 was `service_code` authoring; this update makes no `product_offering_price` change, so none of the three is built.

| # | Unit | Why it is its own unit |
| --- | --- | --- |
| pm57 | **Migration + Drizzle mirror** — `0041_ratecard_ran_usage_lkp.sql`: both tables, both partial unique indexes, the as-of index, and the `PERMISSIONS` row (§6.26). | Schema lands and is verified alone, against a database built from empty (general §3.4). |
| pm60 | **Validation** — `validation/product/ratecard.schema.ts`: row schema, file schema, the `RateCardIssue` line-number contract. | Pure, testable, no DB write. Land it before anything can insert. |
| pm61 | **Parser** — `services/product/ratecard/parse-csv.ts` and the pinned dependency (G-RC4). | A dependency change is its own unit (general §5.6). |
| pm62 | **Repository** — `db/repositories/ratecard.ts`: `insertVersion`, `insertLookupRows`, `setVersionStatus`, the reads. No row-level write of any name. | Guardrail 37 asserts the exported surface; the surface must exist before a service can be judged against it. |
| pm63 | **Upload** — `services/product/ratecard/upload-version.ts` + its action. Structural validation only — no referential query (D-A1). | One mutation, one audit event, one permission level (general §3.3). |
| pm64 | **Diff** — `diff-versions.ts`, in memory. | Read-only; it is the control that makes the DRAFT gate worth anything, and it must exist before Activate can be reviewed. |
| pm65 | **Activate** — `activate-version.ts` + its action: two status flips, no row writes (D-A7). | The lifecycle's consequential act. It gets its own unit, its own tests and its own review. |
| pm66 | **Rollback** — `rollback-version.ts` + its action. | A separate mutation with a separate audit event. |
| pm67 | **Page and read UI** — the route, the guard, `RateCardVersionTable`, `RateCardStatusBadge`, `RateCardRowPreview`, `NAV_REGISTRY` + `NAV_ICONS`. | The read path before any write UI (general §3.2). |
| pm68 | **Write UI** — `UploadVersionDialog`, `UploadErrorTable`, `RateCardDiffPanel`, `ActivateVersionDialog`, `RollbackVersionDialog`, and the `next.config.ts` raise. | The first `<input type="file">` in the tree; it earns its own unit on novelty alone. |
| pm70 | **Demo seed** — one card version aligned with pm48's four-component offering. | Keep seeds attributable: a seed failure must trace to the seed, not to the schema that landed with it. |
| pm71 | **Ship gate** — guardrails 35–37/39–40 landed, 1/13 re-scoped, the §8 sweep, the doc amendments, Appendix A rows cleared by grep. | The gate is never folded into the last feature unit. |

---

## 1. Operating Approach

Apply general §1 in full, plus these.

1. **Read the companion docs before writing a line, and verify the tree before trusting any of their status lines** (§0). Do not infer the current shape from code alone or from docs alone.
2. **Cite the authorizing decision before coding.** Name the RC (the survivors only: RC3′, RC4, RC7, RC8, RC11, RC12, RC15 — RC1, RC2, RC5, RC6, RC9, RC13, RC14, RC16 and RC17 are removed by v2, plan §9), the RV (RV1–RV3 only; RV4 withdrawn by D-A8, RV5–RV9 removed, plan §10), the v2 decision (D-A1–D-A8), the Module Invariant (#45–#60 are this update's), the code-standards rule, or the Part 5 unit that mandates what you are about to build. No citation, no mandate — stop and ask.
3. **Build in the order of §0.2, one unit per pass.** Do not reorder, do not overlap, and do not start a unit whose predecessor is not committed and verified.
4. **Storing the card and consuming it are different sprints with different owners.** This update stores the card; the following-sprint rating work resolves it. A unit that finds itself reasoning about a UDR, a rating chunk, an event catalog or a reject file has left this update (§3.14).
5. **Store; never resolve.** No as-of lookup, no per-UDR resolution, no subscription resolution and no rate arithmetic exists in `services/product/**`, `db/repositories/**` or any component (code-standards §1.35). Product stores a resolution input and performs no resolution.
6. **Make the smallest correct change.** No refactor, rename, folder reorg or dependency change rides along with a unit. The one dependency this update adds is its own unit under G-RC4.
7. **State the unit's scope, files, permission and tests before editing**, and stop and re-scope the moment you touch a file that is not on that list.

### Permanent rules — they never expire, in any unit, in any future phase

Review-blocking defects on sight. The pricing update's own prohibitions remain in force in code-standards §1.21–§1.34 and Inv. #30–#44; the rate card's are in §1.35–§1.48 and Inv. #45–#60. These are the ones that outlive any single update.

- Never create `app/api/product*`, `app/api/ordering*` or `app/api/inventory*`. The engine reads the card by **Postgres grant**, never over HTTP.
- Never add a row-level write to the card. No `updateLookupRow`, no `deleteLookupRow`, no row-editing UI, no service that edits a row, in any layer, under any name. **Upload is the only write path** (Inv. #46).
- Never cache, memoise or snapshot the `ACTIVE` version — no `unstable_cache`, no `revalidate`, no React `cache()`, no module-level store, in the app or in the engine (Inv. #59). The `ACTIVE` version can change at any activation or rollback, so a cached copy is stale the moment it is taken.
- Never write rows at activation or rollback. Both are status flips only; a version is exactly its uploaded file, and there is no carry-forward and no `retired_at` (D-A7).
- Never let an empty cell, a missing column and a missing row share a code path (Inv. #51). Distinct conditions, distinct outcomes.
- Never store the uploaded file (Inv. #58). Filename and checksum only — no blob, no `landing/` drop, no temp file, no retained buffer.
- Never mutate an `ACTIVE` offering, its specifications or its prices in place — branch first via `branchOfferingAsDraft` (Inv. #14).
- Never read a status that gates a branch-or-write decision before the transaction opens. Read it on `tx`, locked, immediately before the decision. This TOCTOU bug was found and fixed four times (pm14, pm15, pm16, pm20); it now also covers `activateVersion`'s lock on the outgoing `ACTIVE` version.
- Never make `is_bundle` user-settable; never add `update*`/`delete*` to the `order_item_price_override` or `inventory_status_history` repositories; never add a `%cycle%` or `%frequency%` column to `ordering.*` or `inventory.*`; never add a migration that repoints a subscription's `product_offering_id`; never weaken order approval.
- Never reshape `ordering.order_item_price_override`, and never reason about it here (plan v2 §3 Out — no consumer, no pricing involvement; Inv. #16/#39). Out of scope means **unchanged** — this update neither reads nor touches it.
- Never write into `enterprise-billing-app/` when the task is planning. Plans, specs and doc updates go to `_plan_enterprise-billing-app/`.

---

## 2. Units — One at a Time

1. **The unit list is `pm00-build-plan.md` Part 5, and it does not exist yet.** Propose §0.2, get it recorded with per-unit specs, then build exactly those in that order. Do not invent a unit, do not re-derive the list in a commit message, and do not build the update as one change because no list exists (G-RC1).
2. **Land each unit's tests in the same commit as its behaviour.** Deferring guardrail coverage to the ship gate repeats the pm24 finding, where guardrails 8, 9 and 14 went unverified for several units. Guardrails 35–37/39–40 land with the units they cover, not at the ship gate.
3. **Split any unit that grows past its Part 5 row.** Finish the smaller piece first and record the split in `pm00-build-plan.md`, not implicitly in commit history.
4. **Do not fold the ship gate into the last feature unit.** It is pm71 and it is where the permission map, the doc amendments and the Appendix A rows are cleared by grep.

---

## 3. Scoping — No Speculative Changes

Apply general §2 in full, plus these. The numbering is fixed; other docs will cite §3.2, §3.5, §3.9 and §3.14 directly.

1. **Do not build anything in the update overview's _Out of Scope_ list.** Any money on the card; any capacity column or capacity semantics; the negotiated override in any form; row-level authoring; the bill-run capacity resolver, `customer_bill_line` mapping, proration, rounding or the BAN aggregation grain; any TMF620 API or adapter; async ingest of any kind.
2. **Do not give `rate_per_unit` any meaning.** It is a plain nullable column stored as-uploaded; nothing reads it, nothing formats it, no rate arithmetic consults it. There is no currency column, and `formatCurrency` is never called on a card row (Inv. #53). A card that drives a price is a different design and needs its own review.
3. **Do not add a capacity column, a capacity field in the upload contract, or a per-UDR capacity split** (RC4). It is not "stored but unused" — there is no column. The source column being named *"SVLCODE mapping for Buffer Usage"* is not an argument.
4. **Do not add a column, a status, a counter or a flag the current unit does not need.** Not a `currency`, not a `capacity_mbps`, not a `last_used_at`, not an `is_current`, not a second version-like sequence. Five `product` tables is the ceiling (code-standards §6.23).
5. **Do not invent a writer for `status = 'REJECTED'` or `reject_summary`.** A failed upload writes nothing, including no version row (code-standards §1.42). Those two exist for a future asynchronous ingest and are **dead in this update** by design. Do not make the column look used.
6. **Do not build async ingest.** No Kestra flow, no `landing/` drop, no staging table, no streaming parse, no queue, no scheduled job, no sweeper (RC15, architecture §5). The engine was considered and set aside; that is not the same as overlooked. Revisit only past ~50k rows per upload, and read RC15 first.
7. **Do not fan out per row.** The upload issues **no** referential query (RV8 withdrawn, D-A1) — and must not grow one per row. No per-row query, no `Promise.all` over rows, no concurrency-limited mapper — §1.16's prohibition applies to the upload path exactly as to a list page.
8. **Do not compute the diff in SQL.** 5,500 rows against 5,500 keyed on four columns is a map comparison in memory. No set-based SQL diff, no temp table. Activation writes no rows at all (D-A7).
9. **Do not make error and warning severities tunable.** The two lists in code-standards §1.41 are fixed. No environment variable, `SYSTEM_CONFIG` key or UI toggle moves a case between them.
10. **Removed (D-A7).** *Was: do not re-validate carried-forward rows.* No row is carried forward; the number is kept so citations resolve. **Do not re-introduce carry-forward** — no copying of keys absent from an upload into the new version, no `retired_at`, no `carried_row_count`.
11. **Do not add a permission beyond the one G-RC3 decides, a level, a page, a route, a segment or a search param beyond `version` and `page`.** `ratecard` is **READ and EDIT only** — the module defines no `ratecard : DELETE`, because nothing on the page deletes anything.
12. **Do not add an audit event type beyond the three** (`RATECARD_VERSION_UPLOADED`, `RATECARD_VERSION_ACTIVATED`, `RATECARD_VERSION_ROLLED_BACK`). Page reads, row previews and diff reads are never audited. Three new types triggers §7.4's ripple in full.
13. **Do not fork a shared primitive.** One action folder, one nav registry, one set of Administration table primitives, one date formatter, one badge per domain union. `RateCardStatusBadge` is a separate component from `LifecycleBadge` and shares no `Record` with it — that is a distinct union, not a fork.
14. **Do not build any consumer of the card — that is the following-sprint rating work, not this update.** No `RATECARD_LOOKUP_MISS`, no `udr_rated` column, no `PER_UNIT` `udr_rate_detail` variant, no drift detection, no `rm02` catalog seed, no `rating-engine-ran-usage.yaml` edit, no card join anywhere, and no `rp.py` amend. This update stands up the table and stops; `rating/**`, `billing/**` and `workflow-management/**` are not opened.
15. **Do not disable, weaken or delete a guardrail to make a unit pass.** Re-baseline 13, re-scope 1 as this update requires; land 35–37, 39 and 40; every other guardrail passes as written.

---

## 4. When to Split

Apply general §3, plus these.

1. **Split the schema from everything that depends on it.** pm57 lands and is verified alone, against a database built from empty.
2. **Split the parser from the validation schema, and both from the service.** The parser owns Inv. #51's distinct parse cases in one file; the schema owns the shape; the service owns the transaction. Collapsing them loses *which layer refused a write*, which is the same split pm47/pm49 preserved for the pricing components.
3. **Split every mutation.** Upload, activate and rollback are three units with three actions, three audit events and three test suites. Activate is never merged into upload — the outgoing `ACTIVE` can change between the two (a rollback), and the diff the user reviewed must be against the version actually superseded.
4. **Split the read UI from the write UI.** The version list and the row preview land before the upload dialog, the error table, the diff panel and the two confirmations.
5. **Split the `next.config.ts` raise out if it grows an argument.** It is a platform-owned file (§6.9); if review stalls on it, land it alone rather than holding the upload UI hostage.
6. **Keep seeds attributable.** The demo card version is its own unit after the services exist, so a seed failure traces to the seed and not to the schema that landed with it.
7. **When in doubt, split.**

---

## 5. Missing or Ambiguous Requirements

Apply general §4, plus these.

1. **Never guess on security, permissions, data shape, effectivity, versioning, lifecycle transitions or audit.** Stop and ask one precise question with options.
2. **Stop and ask on these open items. Do not resolve one yourself, and do not implement one because a test would be easier.**
   - **OR3 — the permission name.** Gate G-RC3. *Owner: user.*
   - **OR4 — file format and parser.** Gate G-RC4. *Owner: user + RevOps.*
   - **OR5 — card identity.** **Retired under v2** — resolved by D-A5 (one seeded card; no card-creation surface). Not a question for this update.
   - **OR7′ — column mapping. Resolved 2026-09-25** (product owner, from the RevOps file layout; plan §12). The header is seven exact, case-sensitive columns in any order — `MNO Name`, `Commercial Unit ID`, `Polygon ID`, `Polygon Start Date`, `Subscriber Reference ID`, `Service Code`, `Rate per Unit` — mapped in pm60 D0. `Polygon ID` → `polygon_id`; `SITE` was never a column. There is no date column (D-A8). Not a question any more — but if `lkp_subscriber_ref_id` turns out to be a customer-facing reference rather than the internal inventory ID, the column's documented meaning changes: raise it rather than silently re-mapping. *Owner: RevOps.*
   - **OR6, OR9, OR10, OR11, OR12 — drift surfacing, feed coverage, the re-rate trigger, the merge point, rate precedence.** All belong to the following-sprint rating work. Not questions for this update.
   - **OR1, OR2, OR8 — closed** 2026-09-22 into RC15, RC17 and RC4. RC17 (carry-forward) has since been removed by **D-A7**, resting on OR2's finding that mediation filters retired polygons upstream. Do not re-litigate them.
3. **Stop and ask on these two doc-vs-doc conflicts. Do not close any of them by editing one side.**
   - **The card repository's path.** `prodmgmt-architecture.md` §2 names `db/repositories/product/ratecard.repository.ts`; code-standards §7.8 settles it as flat `db/repositories/ratecard.ts` and every product repository on disk is flat. **Code-standards wins on a convention question** — but do not create the file until architecture §2 is corrected in the same change set. A nested path here silently starts a second convention.
   - **The `PERMISSION_NAMES` count.** Architecture §1 says 15 → 16; the tree says 14 → 15 (§0). **Count the file, not the doc**, and correct architecture §1.
4. **Never invent a column, a status value, a violation code, an issue shape or a severity.** They are all fixed and owned elsewhere: the two tables in architecture §3.2/§3.3, the four version statuses in code-standards §2.19, `RateCardUploadViolation` and `RateCardIssue` in §2.24/§2.25, the four diff buckets in §2.28. If the plan does not show a field, it does not exist.
5. **Never guess the effectivity window.** `polygon_start_date <= event_time`, closed on the right by the next `polygon_start_date` for the same key. `snapshot_date` never participates in matching, and is never read from the file: it is the upload date in the app timezone, set by the upload service (D-A8). Do not add a date column to the contract. (The v1 `retired_at` clause is gone with D-A7; how a consumer resolves a past period is out of scope.)
6. **Removed (D-A7).** *Was: never guess the carry-forward.* There is no carry-forward: activation is two status flips and a key absent from the upload is simply *removed* in the diff. The number is kept so citations resolve.
7. **Stop and ask if a unit appears to need an exception** to the DRAFT gate, to version immutability, to the upload-only write path, or to the no-cache rule. It almost certainly means a control is being bypassed rather than a case being handled.
8. **Record every resolution in the owning companion doc** in the same change set, so the next agent does not re-ask.

---

## 6. Files You Must Not Modify Without Explicit Instruction

The general §5 list applies in full. Module-specific:

1. **`components/ui/`** — managed vendor layer. Compose new components in `components/products/rate-card/`.
2. **Applied migrations.** Never edit or delete one. Every schema change in this update is `0041_ratecard_ran_usage_lkp.sql`, forward-only.
3. **`db/migrations/0006_product.sql` — locked again.** G-C's in-place-edit authorization was granted for **pm46 only** and has been consumed (§0). It does not extend here (RC12). Do not reopen it, and do not substitute a different shape on your own initiative.
4. **Never write a migration that adds an enum value and then uses it.** The migrator applies all pending files in one transaction and Postgres rejects the use (`unsafe use of new value`, verified on PG 16.13).
5. **`rate_per_unit` carries no CHECK and no meaning** — it is a plain nullable column stored as-uploaded. Do not add a constraint, a trigger or an application guard around it, and do not build anything that reads it; giving it a rating meaning is a different design (§3.2).
6. **View Product's files** — `app/(app)/products/product-offering/**` (nav label and page `H1` only) and `components/products/*.tsx`. `components/products/rate-card/**` imports nothing from `manage/`, and `manage/` imports nothing from it (code-standards §7.11).
7. **`rating/**`, `billing/**` and `workflow-management/**`** — untouched from this update. This update builds no consumer, so there is no legitimate reason to open them at all; `rp.py` in particular is not amended.
8. **`ordering/**` and `inventory/**`** — untouched, in every unit. No unit reads `inventory.product_inventory` either — the v1 RV8 referential read is withdrawn (D-A1); the upload reads no other module. `ordering.order_item_price_override` is not read, modified, reshaped or reasoned about (plan v2 §3 Out).
9. **`next.config.ts` and `types/rbac.ts` — platform-owned, edited by this module, and each must be called out in review.** Neither is covered by code-standards §7's tree. Neither may be folded silently into a unit diff, and `types/rbac.ts` waits on G-RC3.
10. **Better-Auth managed tables and the `auth/` field mapping** — this module only FKs `core.APPUSER` via `uploaded_by` / `activated_by`.
11. **The permission registry mechanism** — the `ratecard` row comes only from `0041`, beside the page's DDL. No code path inserts `PERMISSIONS` rows, and a permission with no page (or a page with no permission) is exactly the failure general §1.11 forbids.
12. **`tsconfig` strict flags, ESLint, Prettier, CI (`infra/**`)** — never weaken a gate to pass. A red tree is resolved by re-cutting the unit, never by relaxing a gate.
13. **`db/bootstrap/rating-db-roles.sql` and `db/bootstrap/billrun-db-roles.sql`** — no change is needed and none may be made. `rm03` already grants `rating_runtime` `SELECT` on the `product` schema, so both new tables are readable as created. A unit editing a bootstrap role file has misdiagnosed a reader break as a permission problem.
14. **Existing Administration routes, URLs and authz results** — byte-identical (Inv. #12). Adding `ratecard` to a closed union must change no existing principal's effective permissions.
15. **`components/products/prices-panel.tsx`, `db/repositories/product-offering-price.ts`, `services/product/validate-offering-components.ts` and the rest of the pricing update's files.** This update makes **no** change to `product_offering_price` or its readers — no partition amend, no `service_code`, no `AMBIGUOUS_RATE_CARD`. Leave all of them exactly as the pricing update shipped them.

If a unit genuinely requires touching any of these, stop, explain why, and get explicit confirmation.

---

## 7. Keeping Docs in Sync

1. **Land the doc amendment before or with the unit that makes it true.** Inv. #2, #28, #34 and #42's amendments land with pm57; the code-standards §7 tree markers land as files appear; the ui-context copy lands with the unit that renders it. Never ship code a doc still forbids.
2. **Clear an Appendix A row only by grep, never from memory.** Rows **A10–A14** are in `prodmgmt-code-standards.md` Appendix A with their clearing units; this file's Appendix A carries only the workflow-specific rows. A row that outlives its code is drift.
3. **Correct the two stale statements of §0 as part of the units that touch them**, and record the correction in every doc that carries it — not in one place. §7.10 exists because a doc/code disagreement went unrecorded for a whole update cycle.
4. **Three new audit event types ripple past `tsc`.** Each needs its `AUDIT_EVENT_TYPES` entry, its `AUDIT_EVENT_CATEGORY_MAP` entry (`tsc`-caught) **and** the count/optgroup fix in `tests/components/audit-log-filters.test.tsx` (**not** `tsc`-caught). This has bitten every write unit in this module's history.
5. **This update changes the permission map — say how many rows, explicitly, at the gate.** Four rows for `/products/rate-card` (§8 of code-standards). **Do not carry the pricing update's "adds no row" sentence into this gate**; it is false here.
6. **Update `prodmgmt-architecture.md` §4 and `prodmgmt-code-standards.md` §8 in the same change set** whenever a page, route, component, folder or `permission : level` changes. Each fact in one place, both docs in one commit.
7. **Owning doc per fact:** product behaviour → `prodmgmt-update-overview.md`; a decision, an invariant or an open item → `_updatemodule-ratecard-lookup-plan-v2.md`; schema, lifecycle or Module Invariant → `prodmgmt-architecture.md`; convention, type, component name or guardrail → `prodmgmt-code-standards.md`; token, copy or rendering → `prodmgmt-ui-context.md`; units → `pm00-build-plan.md`; workflow → this doc; build history → the trackers. Reference, never copy.
8. **Component and code names are binding.** `RateCardVersionTable`, `RateCardStatusBadge`, `UploadVersionDialog`, `UploadErrorTable`, `RateCardRowPreview`, `RateCardDiffPanel`, `ActivateVersionDialog`, `RollbackVersionDialog`, `RATECARD_INSERT_BATCH_SIZE`. Create exactly these — the UI copy and the tests key off them.
9. **Cross-module doc edits need explicit approval — and none is owed by this update.** Any rating-side reconciliation (e.g. `ratemgmt-progress-tracker.md`'s "subscription lookup table" open question, and whether a consumer snapshots the `ACTIVE` version) belongs to the following-sprint rating work that consumes the card, not here. Do not write into the rating module's docs from this update.
10. **Record every doc/code disagreement where you find it, in every doc that carries it.** Correcting one copy and moving on is how the original defect was created.
11. **Document the reserved column's deliberateness, not just its existence.** `reject_summary` and `status = 'REJECTED'` have no writer in this update (§3.5), and `rate_per_unit` is stored as-uploaded but read by nothing. Say so in the schema doc-block so the next reader does not spend an afternoon hunting the code path that consumes them.

---

## 8. Verification — Before the Next Unit

Run the general §8 checklist in full, plus every item below. If any fails, the unit is not done. The full guardrail wording lives in code-standards §9 — this is the run list, not a second copy.

1. **Guardrails pass**, each **landed, not assumed**: **1** gains four `/products/rate-card` rows at both levels in both directions; **13** re-baselined a third time (both tables, both partial unique indexes, the as-of index); and the new ones — **36** a version is exactly its file (re-scoped by D-A7), **37** upload is the only write path, **39** one ACTIVE per card enforced by the index, **40** no cache on the card. **Guardrails 35 (reserved `rate_per_unit` column) and 38 (partition-key parity) are not part of this update** — `rate_per_unit` is a plain column with no CHECK, and there is no `service_code` or `product_offering_price` change. (Guardrails 16 and 27's rate-card extensions are likewise dropped.)
2. **Migrations.** `npm run db:migrate` on an **empty** database produces both tables, the partial unique index on `card_name WHERE status = 'ACTIVE'`, the `DRAFT` partial index, and the as-of index. `0006_product.sql` and `product_offering_price` are untouched. No backfill script exists anywhere in the result — **assert its absence**, do not merely refrain from writing one.
3. **Upload refusals create no version row.** Each of these is refused with a row-level report and **nothing written**: a duplicate `(mno, cu, polygon, polygon_start_date)`; a `Date` (or any other unknown) column; a missing expected column; a cell failing its type. There is no subscription-referential refusal (D-A1).
4. **Warnings do not block.** A `file_checksum` match surfaces on the draft review, never refuses, and activation still proceeds. It is the only warning (code-standards §1.41).
5. **Empty-cell discipline.** A parsed empty cell arrives as `""` and stores as NULL, never `0`; a missing column rejects the file; a missing row is not a parse error. Assert Inv. #51's distinct cases separately.
6. **Activation is two status flips and nothing else.** The `DRAFT` is promoted and the prior `ACTIVE` demoted to `SUPERSEDED`, in one transaction under one row lock. **No row is written** to `RATECARD_RAN_USAGE_LKP`: assert the new version's stored rows equal its uploaded file (`row_count`), and that a key absent from the upload is absent from the new version and still present in the superseded one (D-A7).
7. **The database enforces, not the code.** A direct SQL insert producing a second `ACTIVE` version for one `card_name` is rejected by the partial unique index. A direct `UPDATE` or `DELETE` against an `ACTIVE` version's row is rejected.
8. **Rollback is a status change, not an edit.** Re-activating a `SUPERSEDED` version restores it and demotes the current one; no row of either version is modified.
9. **Batching and budget.** Rows insert in 1,000-row batches from the single `RATECARD_INSERT_BATCH_SIZE` constant, inside one transaction. The upload issues no referential query (D-A1) and no per-row query. The page query budget holds — one versions query plus its count on first render, one paged rows query plus its count on selection, two full reads for a diff — **including after a failed upload**.
10. **Audit.** Exactly one event per upload, activate and rollback, in the same transaction as the write, using the three new types; the activation payload carries the superseded version id and the three diff counts (added / changed / removed). Page reads, row previews and diff reads write nothing. The non-`tsc`-caught filter assertion is updated (§7.4).
11. **Authorization end to end.** The page guard is present; every mutation re-checks `permission : level` server-side; a principal with READ only is refused upload, activate and rollback **at the action guard** and receives no partial effect; `ratecard` overlaps `products`, `product_orders` and `product_inventory` in neither direction; the `NAV_REGISTRY` entry hides the page rather than showing it locked.
12. **The upload boundary.** The file comes off `FormData` after `requirePermission`; the server re-parses and re-validates the entire file unconditionally; the client header sniff grants nothing; the file never enters react-hook-form state and is never serialised to JSON or base64.
13. **Data layer.** SQL only in `db/**`; the card repository exports no row-level update or delete; every status-gated decision reads on `tx`, locked; no cache wraps a card read and the page is `force-dynamic`.
14. **Partition-key parity — not applicable to this update.** This update makes no `service_code` change and no `product_offering_price` partition amend, so there is no parity to verify here. `db/repositories/product-offering-price.ts`, `rp.py` and `bill_run_processing.template.yml` are all left exactly as the pricing update shipped them.
15. **`EXPECTED_PRODUCT_ACTION_FILES` moved by exactly three**, and the CSV parser is imported in exactly one file.
16. **Docs in sync** — the owning doc updated in the same change set; the two stale statements of §0 corrected where they live; Appendix A rows cleared by grep.
17. **Build gates.** `tsc --noEmit`, ESLint, Prettier, the full test suite, SAST and the DAST baseline clean. Orders, Subscriptions, View Product, Manage Products and every Administration route green and unchanged; the rating and bill-run flows green. **A unit may not commit red** — if it cannot land green, re-cut it.
18. **No forbidden edits.** Nothing from §6 touched without confirmation; `0006_product.sql` untouched; `product_offering_price` and `rp.py` untouched; no `app/api/product*`; no secret; no `TODO`, commented-out code or `console.*` on the branch.

---

## Appendix A — Workflow rules superseded, cleared or newly opened

The full superseded-rule register is `prodmgmt-code-standards.md` Appendix A, rows **A1–A14** — read it there; it is not duplicated. Only rows whose subject is a **workflow rule in this file** are tracked below. Clear a row by grep, never from memory.

| #  | Rule | State | Clears with |
| --- | --- | --- | --- |
| W1 | `0006_product.sql` is locked; forward-only migrations are the rule. | **Reaffirmed.** G-C was granted for pm46 and is consumed; it does not extend to this update (RC12). The lock stands. | never — it is the standing rule |
| W2 | The conceptual PU1–PU6 buckets as a unit list. | **Cleared 2026-09-21**, superseded by `pm00-build-plan.md` Part 4. Retained here only so stale PU references resolve. | cleared |
| W3 | General §1.3/§3.7 — every unit lands green — as applied to pm46–pm54. | **Cleared.** G-E resolved 2026-09-21 as a **squash**: pm46–pm54 land on one branch and reach `main` as one atomic commit, green at its boundary. The general rule is therefore never violated and needs no suspension. This update opens no equivalent window; each unit lands green on its own. | cleared |
| W4 | The `order-preconditions.ts` doc-vs-doc conflict (code-standards A9). | **Cleared.** pm50 shipped the override-target re-key under G-G; `services/ordering/order-preconditions.ts` now resolves on `componentType`. Verified 2026-09-23. | cleared |
| W5 | Architecture §3.5 / code-standards §6.29 — *"`rp.py` (pm51) — write it with `service_code` in the partition from the start."* | **Out of scope under v2.** This update makes no `service_code` change and no `rp.py` amend; the stale sentence is the following-sprint rating work's to reconcile, not this update's. G-RC5 is withdrawn. | not this update |
| W6 | Architecture §2 — the card repository at `db/repositories/product/ratecard.repository.ts`. | **Contested.** Code-standards §7.8 settles it flat as `db/repositories/ratecard.ts`, matching every product repository on disk. Correct architecture §2 before the file is created. | pm62 |
| W7 | Architecture §1 — *"`PERMISSION_NAMES` is a closed union of 15; this makes it 16."* | **False.** The tree has 14; `ratecard` makes 15. | pm57 |
| W8 | Gate G-A — the pm35–pm45 delivery record is verified false. | **Overtaken.** `dev1` now carries Part 3 plus pm46–pm51, so the claim is true by construction rather than by correction. Code-standards' Status block still says otherwise (§0) and is the remaining drift. | pm71 |

**Unresolved, tracked here because it has no other home:** `prodmgmt-code-standards.md`'s Status block describes the pricing update as PLANNED and gated on G-0 and G-C, and pm35–pm45 as delivery-unverified. Both were true when written and are not true now. Until that block is corrected, do not cite it as evidence of what is or is not built — count the tree instead (§0).
