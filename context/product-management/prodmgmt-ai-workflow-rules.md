# Product Management — AI Workflow Rules (Module Supplement)

This document supplements `context/ai-workflow-rules.md` (binding for all modules — read it first); everything there applies unchanged. The module is now **fully editable**: both the read-only catalog (View Product) and the CRUD surface (Manage Products) are implemented and ship-gate-verified (units pm01–pm24). One further phase is **planned but not built**: the **Product Ordering & Inventory update** (Orders + Subscriptions pages, `ordering`/`inventory` schemas). This doc pins the module's guardrails, permissions, protected files, and doc-section references for any future work on the module (bug fixes, the Ordering update, or unrelated changes that happen to touch this module's files).

**Companion docs (authoritative — do not restate or contradict):**

- `prodmgmt-project-overview.md` — product spec: user flows (View Product + Manage Products), the four-section page, the CRUD/versioning model, 3-table data model, in/out of scope, success criteria.
- `prodmgmt-architecture.md` — technical design: `product` schema, JSONB usage, permission matrix (§4), 22 numbered **Module Invariants** (§6; #15–22 belong to the planned Ordering update).
- `prodmgmt-code-standards.md` — module coding conventions, file tree (§7), permission map (§8), guardrail tests (§9). Catalog scope only until the Ordering update is built.
- `prodmgmt-progress-tracker.md` — build history: unit-by-unit notes for pm01–pm24, plus the recurring-ripple patterns any future unit is likely to hit again (permission-name additions, new-audit-event-type additions, new-pgSchema integration-test setup, etc.).
- **Ordering update (planned):** `prodmgmt-update-overview.md` (spec, scope, success criteria) and `_updatemodule-product-ordering-inventory-plan.md` (decisions Q1–Q20, tables, sample data) are the authorizing documents for that work — a unit implementing the update cites them, not the catalog overview. Hard dependency: the accounts module's `billing.*` tables ship first (architecture header).

**Precedence** per the general doc: module architecture **Invariants** → overview → architecture → code-standards → this supplement → general workflow rules.

---

## 1. Operating Approach — Module Specifics

1. **The module is fully built; treat new work as an addition to a live system, not a fresh build.** Before writing code for any new unit, read the companion docs above in full — they describe the *current*, shipped shape of the module, not a plan. A request that sounds like it wants v1's old "read-only, no mutations" behavior is describing a state that no longer exists; confirm scope against the current docs rather than assuming.
2. **Cite the authorizing section before coding**, per the general doc §1.1 — an overview feature, an architecture §2 folder row, or a code-standards rule. No section, no mandate. This still applies in full: the module being CRUD-capable does not mean unscoped mutation code is pre-authorized. A genuinely new feature (e.g. a third product page, a new lifecycle transition, a new entity) still requires the same explicit-authorization discipline v1 used for its own CRUD fast-follow.
3. **The route-group rename and the nav refactor are historical** (pm01, pm04) — both are done and are platform-level precedent for future modules, not open work items here.
4. **The five permanent, cross-phase rules that never expire**, regardless of what future work touches this module:
   - `app/api/product*` is never created, in any phase (architecture §5, code-standards §5).
   - The price repository never gains `update*`/`delete*` — `insertPrice` is its only write, forever (Inv. #1).
   - `is_bundle` is never user-editable in any form (code-standards §1 rule 9).
   - Editing an `ACTIVE` offering never mutates it in place — always branch first via `branchOfferingAsDraft` (Inv. #14).
   - Every branch-vs-in-place decision reads its target's status inside the transaction, locked, immediately before the decision — never a pre-transaction snapshot (code-standards §1 rule 13; this exact TOCTOU bug was found and fixed independently in pm14, pm15, pm16, and pm20 — treat a pre-transaction status read as a review-blocking defect on sight).

   The Ordering update, once built, adds its own permanent rules of the same rank (architecture Inv. #15–22) — most critically: the `inventory_status_history` and `order_item_price_override` repositories never gain update/delete; no cycle/frequency column ever appears on `ordering.*`/`inventory.*` tables; order approval always re-runs full validation under locks and never accepts reviewer = submitter.

## 2. Units — One at a Time

The general doc's "one unit at a time, in dependency order, previous unit verified and committed before the next starts" (§2) still governs any future work. The module's original build order (pm01–pm24) is recorded in full, unit-by-unit, in `prodmgmt-progress-tracker.md` — treat it as the reference example of how this module gets built in dependency-ordered, independently-verified slices, not as a checklist with remaining items. A new unit of work (bug fix, extension, Phase 3 feature) gets its own fresh unit plan following that same discipline; it does not resume the pm-numbering sequence unless the user says otherwise.

## 3. Scoping — No Speculative Changes

1. **Do not** create a second Route Handler surface, a second nav component, or a parallel table implementation — the module has exactly one of each pattern (`actions/product/`, `components/admin-nav.tsx`, the shared Administration table primitives) and forking one is a defect, not a convenience.
2. **Do not** build out-of-scope features without explicit instruction: CSV export, `bundle_link`/child-offering views, a `product_pricing` permission split, tier child tables, `policy`-column semantics, hard delete of any product entity, merging or splitting version families, or a second schema addition beyond `family_offering_id` **to the `product` schema** (overview *Out of Scope*, architecture §5). This rule scopes the *catalog*: the planned Ordering update's `ordering`/`inventory` schemas are separately authorized by `prodmgmt-update-overview.md` and do not touch the `product` schema at all — an ordering unit that finds itself modifying `db/schema/product.ts` is out of bounds and must stop.
3. **Do not** add columns, flags, or abstractions the current unit doesn't need — including a stored `end_date_time` or `last_update` on prices (Inv. #3) or a second `version`-like counter.
4. **Do not** touch Administration pages or other modules' files beyond genuinely shared primitives you extend (never fork, code-standards §4.2/general §5). Unrelated fixes: note and raise separately.
5. **Respect layer boundaries**: `page.tsx` files are thin orchestrators — no DB access, no business rules; `services/product` has no `next/*` imports; SQL lives only in `db/**`; `actions/product/**` has no DB access of its own.
6. **Do not** add `update*`/`delete*` to the price repository, for any reason, in any future unit (Inv. #1, permanent).
7. **Do not** add a hard-delete path for offerings, or for a specification on a non-`DRAFT` offering — every removal is a status transition (Discard/Retire) or the existing DRAFT-only spec delete, never a row deletion.
8. **Do not** make `is_bundle` user-settable in any form, dialog, or schema.
9. **Do not** write an in-place `UPDATE` to an `ACTIVE` offering's own columns, its specifications, or its prices, in any service — always branch first (Inv. #14). If a unit seems to need an exception to this, stop and ask — it almost certainly means the branch primitive is being bypassed, not that an exception is warranted.
10. **Do not** attempt to merge two version families, split one family into two, or move a row from one family to another — out of scope, not designed, and not requested.

## 4. When to Split

Apply the general doc §3 triggers, plus these module-specific splits:

1. **Split a schema migration from the behavior that depends on it** — land and verify the migration in complete isolation before repository code depends on it (the pattern pm01/pm10 both used).
2. **Split each page section or dialog** — table, detail, specs panel, prices panel on View Product; each dialog/form on Manage Products — are separate units; do not deliver a multi-section page in one pass.
3. **Split a new write primitive from every service that will call it** — e.g. if a future primitive analogous to `branchOfferingAsDraft` is ever needed, build and thoroughly test it as its own unit before wiring it into callers; none of those callers should be the first place its behavior gets exercised.
4. **Split guardrail/versioning-invariant tests to land with the unit that introduces the behavior, not deferred to a later ship-gate unit** — the module's own history (pm24's pre-flight audit) found that deferring this coverage let guardrails 8/9/14 go unverified by committed tests for several units; land the test in the same commit as the behavior.
5. **When in doubt, split.**

## 5. Missing or Ambiguous Requirements

Follow the general doc §4: resolve from the docs first, cite the section; otherwise stop and ask one precise question with options. Never guess on security, data shape, permissions, effectivity, versioning, or constraints. Module-specific:

1. **Still-deferred decisions — do not resolve them yourself:** `policy` column semantics (carried as nullable text), tier storage migration to a child table, a pricing-visibility permission split, bundle composition. If a unit seems to need one, stop and ask.
2. **Never invent JSONB shapes.** `product_spec_characteristics` and `pricing_characteristics` shapes come from the Zod schemas in `validation/product/`; if a needed shape isn't specified, ask (Inv. #4).
3. **Never guess price-effectivity or backdating semantics.** End is derived from the successor's `start_date_time`; future-dated prices don't displace current ones early; backdating tolerance is exactly 3 days, checked against real time in the service layer. Anything unclear here is a stop-and-ask, never a default.
4. **Never guess versioning semantics.** `version` is a family-relative sequence number, not a per-edit counter; `family_offering_id` resolves in exactly one hop to the root. Any change to this convention is a protected-file-level decision (§6 below), not a build-time call.
5. **Record every resolution** in the owning companion doc so the next agent doesn't re-ask (general doc §4.6).

## 6. Protected Files — Module References

The general doc §5 list applies in full. Module-specific detail and additions — do not touch without explicit instruction:

1. **`components/ui/`** — managed vendor layer. Build new indicator/form components in `components/products/` or `components/products/manage/` by composition.
2. **Better-Auth managed tables and `auth/` mapping** — this module only references `core.APPUSER` by FK (`last_edited_by`); it creates no identity/RBAC/session/config/audit tables (Inv. #9).
3. **Applied migrations** — forward-only; new constraints or columns ship in a new migration, never by editing an applied one.
4. **Permission registry mechanism** — the `products` row (READ/EDIT/DELETE) comes only from its committed migration; no code path inserts PERMISSIONS rows.
5. **`tsconfig` strict flags, ESLint/Prettier, CI (`infra/**`)** — including the rename-invariance CI check; never weaken a gate to pass.
6. **Lockfiles/dependencies** — no DB extensions are needed for this module; any npm dependency change is its own requested unit.
7. **Existing Administration routes, URLs, and authz results** — must stay byte-identical (Inv. #12).
8. **`TOREMOVE-Template-*` seed rows** — keep the prefix; never make production code depend on them; replacing them is a go-live data-migration task, not module code.
9. **The price repository's exported surface** — adding `update*`/`delete*` price functions is forbidden permanently (Inv. #1).
10. **The `family_offering_id` linkage convention** (`NULL` = root, non-null always resolves to the root in one hop) — changing it would silently corrupt every family's version lineage. Touching it requires stopping and getting explicit confirmation.
11. **`app/(app)/products/product-offering/**` and its existing components** — may only be touched for nav label / page `H1` text; any other edit is out of bounds without stopping to explain why (View Product's read-only guarantee is structurally enforced and guardrail-tested).

If a unit genuinely requires touching any of these, stop, explain why, and get explicit confirmation.

## 7. Docs in Sync

Per the general doc §6, plus:

1. **Permission map** — a change to either page, its components, or the permission ships with the matching rows in `prodmgmt-architecture.md` §4 and `prodmgmt-code-standards.md` §8 in the same change set.
2. **Registry + map + guard together** — the `products` PERMISSIONS row, the map rows, the typed constant (`PERMISSIONS.PRODUCTS`), and both page guards move as one traceable set whenever any of them changes.
3. **Cross-module doc edits** — any change touching another module's docs needs explicit approval; the historical rename/nav-refactor cross-edits to `usrmgmt-*` docs are done and are not a template for casual cross-module edits going forward.
4. **Owning doc per fact:** product behavior → overview; schema/Invariant → architecture; convention/component names → code-standards; workflow → this doc; build history/ripple patterns → progress tracker. Reference, don't copy.
5. **Component names are binding** — create exactly the names listed in code-standards §4/§7/§8, or the page↔route↔component↔permission chain breaks.
6. **New audit event types ripple beyond `tsc`.** A new `AUDIT_EVENT_TYPES` entry needs an `AUDIT_EVENT_CATEGORY_MAP` entry (`tsc`-caught) *and* a count/optgroup fix in `tests/components/audit-log-filters.test.tsx` (**not** `tsc`-caught) — this has bitten every Phase 2 write unit; check it explicitly rather than trusting the type checker.

## 8. Verification — Before the Next Unit

Run the full general doc §8 checklist, with these module readings and additions:

1. **Guardrail tests pass** — all fourteen in code-standards §9: authz matrix (both pages, incl. EDIT-vs-DELETE split), price immutability (structural + behavioral), overlap constraint, derived effectivity, JSONB/Zod validation, deep link, rename invariance, single-active-per-family, branch-not-mutate, spec-delete-unreachable-on-ACTIVE, view-stays-read-only, route manifest, schema-diff, TOCTOU-safe status reads.
2. **Authorization** — `requirePermission('products', 'READ')` on View Product, `requirePermission('products', 'EDIT')` on Manage Products (with `DELETE` re-checked on retire/discard); no-grant → no-access; no partial rendering of specs/prices under a weaker check (Inv. #10); deep links pass through the same guard.
3. **Audit** — every mutation's transaction ends with exactly one `insertAuditEvent` call, inside the same transaction as the data change, using one of the module's audit event types (architecture §5); confirm View Product reads still write **no** `AUDIT_LOG` rows.
4. **Data layer** — SQL only in `db/**`; constraints enforced by the DB, Zod additional (code-standards §6); `created_at` and `start_date_time` both present and distinct on prices; no stored `end_date_time` anywhere (Inv. #3); any status-gated branch decision reads via a locked query on `tx`, not `db` (code-standards §1 rule 13).
5. **URL state** — View Product's list/selection state lives in searchParams, parsed never trusted, RETIRED hidden server-side by default, invalid params fall back to schema defaults (code-standards §3).
6. **Read models** — services return `OfferingListRow` / `OfferingDetail` / `SpecificationCard` / `PriceCard` (or the Manage Products family-grouped shape), not raw Drizzle rows (code-standards §2.7).
7. **Build gates** — `tsc --noEmit`, ESLint, Prettier, full test suite, SAST + DAST baseline clean; existing Administration pages green under `(app)` with identical URLs.
8. **No forbidden edits** — nothing from §6 above touched without explicit confirmation; no `app/api/product*` path exists; no `TODO`, commented-out code, or `console.*`.

If any item fails, the unit is not done. Fix it before moving on.
