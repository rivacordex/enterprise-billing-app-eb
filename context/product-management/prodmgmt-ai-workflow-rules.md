# Product Management — AI Workflow Rules (Module Supplement)

This document supplements `context/ai-workflow-rules.md` (binding for all modules — read it first); everything there applies unchanged, and the **Product Module deltas** are: **v1 is strictly read-only, so there are no mutation units, no Server Actions, no Route Handlers, and no new audit events** (general doc §3.3 mutation-splitting and §8.6 audit checks apply only when the CRUD fast-follow starts); the module adds two **platform-level prerequisite units** — the `(admin)` → `(app)` route-group rename and the `NAV_ITEMS` → `NAV_SECTIONS` nav refactor — that must land before any product page; and the protected-files list gains module-specific entries (no `actions/product/`, no `app/api/product*`, no price `update*`/`delete*` functions, `TOREMOVE-Template-` seed prefixes). This doc pins the module's units, guardrails, permissions, protected files, and doc-section references.

**Companion docs (authoritative — do not restate or contradict):**

- `prodmgmt-project-overview.md` — product spec: user flow, the four-section page, 3-table data model, in/out of scope, success criteria.
- `prodmgmt-architecture.md` — technical design deltas: `product` schema, JSONB usage, permission matrix (§4), 12 numbered **Module Invariants** (§6).
- `prodmgmt-code-standards.md` — module coding conventions, file tree (§7), permission map (§8), guardrail tests (§9).

**Precedence** per the general doc: module architecture **Invariants** → overview → architecture → code-standards → this supplement → general workflow rules.

---

## 1. Operating Approach — Module Specifics

1. **Build only v1 scope.** v1 is a read-only catalog viewer at `/products/product-offering`. Do not write any create/update/delete UI, service method, action, or "disabled" placeholder for it (code-standards §1.1). Treat any mutation request as the CRUD fast-follow — a separate, explicitly authorized phase.
2. **Cite the authorizing section before coding**, per the general doc §1.1 — an overview feature, an architecture §2 folder row, or a code-standards rule. No section, no mandate.
3. **Keep everything CRUD-ready but additive-only** (code-standards §1.5). Do not pre-build mutation code; do design schema, repositories, `services/product`, and Zod schemas so the fast-follow adds functions without renaming or re-shaping v1. Flag any v1 design that would force a breaking change — it is a review-blocking defect.
4. **Do the route-group rename first among UI steps** (architecture §2, Decision #10). The rename commit moves `app/(admin)/**` → `app/(app)/**` and updates the `@/app/(admin)/…` imports — nothing else (code-standards §7.4).

## 2. Units — One at a Time

Deliver these as separate units, in this dependency order (general doc §2). Do not start a unit until the previous one passes verification (§7 below) and is committed.

1. **Route-group rename** `(admin)` → `(app)` — a platform-level change authorized per the general doc §2.8; URL-invariant; CI must prove every existing Administration route and authz-matrix result unchanged (Inv. #12) before any product code lands.
2. **DB foundation** — `product` schema, 3 tables (`product_offering`, `product_specifications`, `product_offering_price`), sequences (`PRDOFR`/`PRDSMD`/`PRDOFP`), enums, the UNIQUE effectivity-start constraint (overlap, Inv. #2, revised 2026-07-04) and CHECK constraint (`amount` XOR tiers, Inv. #5), plus the `products` PERMISSIONS seed row — one migration unit.
3. **Validation schemas** — `validation/product/`: offering-list searchParams schema; per-`pricing_model` discriminated `pricing_characteristics` schemas (tiered = contiguous, non-overlapping bounds, Inv. #4).
4. **Seeds** — `TOREMOVE-Template-*` rows, passed through the Zod schemas; must trip the overlap constraint if wrong (code-standards §1.7).
5. **Repositories + `services/product`** — `listOfferings` (search/filter/sort/pagination, RETIRED hidden by default) and `getOfferingDetail` (offering + specs + prices + derived `endDateTime`). The price repository exports no `update*`/`delete*` — ever (Inv. #1, code-standards §1.2).
6. **Nav refactor** — `NAV_ITEMS` → `NAV_SECTIONS` in `components/admin-nav.tsx`; add "Products" section; collapsed-rail behavior unchanged. No second nav component.
7. **Page — one section per unit**: guard + params + offerings table → offering detail → specifications panel → prices panel (incl. `TierTable`, `formatCurrency`). Each with its tests.
8. **Authz-matrix entry** for `/products/product-offering` and the remaining §9 guardrail tests.

There are **no mutation units in v1** (Inv. #11). Data enters via seeds and engineer-run SQL only.

## 3. Scoping — No Speculative Changes

1. **Do not** create `actions/product/`, `app/api/product*`, mutation service methods, lifecycle-transition logic, or EDIT/DELETE-gated UI. Their creation marks the start of the CRUD fast-follow and requires explicit instruction (code-standards §1.1, §5.3, §7.2).
2. **Do not** build out-of-scope features: CSV export, `bundle_link`/child-offering views, a `product_pricing` permission split, tier child tables, `policy`-column semantics, or audit events for reads (overview *Out of Scope*, architecture §5).
3. **Do not** add columns, flags, or abstractions the current unit doesn't need — including a stored `end_date_time` or `last_update` on prices (Inv. #3) or versioned offering rows (Inv. #8).
4. **Do not** touch Administration pages beyond the mechanical rename/import updates and the shared table primitives you extend (never fork, code-standards §4.2). Unrelated fixes: note and raise separately.
5. **Respect layer boundaries**: page.tsx is a thin orchestrator — no DB access, no business rules; `services/product` has no `next/*` imports; SQL lives only in `db/**`.

## 4. When to Split

Apply the general doc §3 triggers, plus these module-specific splits:

1. **Split the rename from everything else** — it is its own reviewed, CI-proven commit.
2. **Split the migration from behavior** — schema + constraints + permission seed land and are verified before repositories consume them.
3. **Split each page section** — table, detail, specs panel, prices panel are separate units; do not deliver the four-section page in one pass.
4. **Split each guardrail** — every §9 code-standards guardrail test (immutability, overlap, derived effectivity, JSONB validation, deep link, rename invariance, authz matrix) gets a focused step.
5. **When in doubt, split.**

## 5. Missing or Ambiguous Requirements

Follow the general doc §4: resolve from the docs first, cite the section; otherwise stop and ask one precise question with options. Never guess on security, data shape, permissions, effectivity, or constraints. Module-specific:

1. **Known deferred decisions — do not resolve them yourself:** `policy` column semantics (carried as nullable text), tier storage migration to a child table, pricing-visibility split, bundle composition. If a unit seems to need one, stop and ask.
2. **Never invent JSONB shapes.** `product_spec_characteristics` and `pricing_characteristics` shapes come from the Zod schemas in `validation/product/`; if a needed shape isn't specified, ask (Inv. #4).
3. **Never guess price-effectivity semantics.** End is derived from the successor's `start_date_time`; future-dated prices don't displace current ones early. Anything unclear here is a stop-and-ask, never a default.
4. **Record every resolution** in the owning companion doc so the next agent doesn't re-ask (general doc §4.6).

## 6. Protected Files — Module References

The general doc §5 list applies in full. Module-specific detail and additions — do not touch without explicit instruction:

1. **`components/ui/`** — managed vendor layer. Build `LifecycleBadge`, `PriceTypeBadge`, `CharacteristicChip`, `TierTable` in `components/products/` by composition.
2. **Better-Auth managed tables and `auth/` mapping** — this module only references `core.APPUSER` by FK (`last_edited_by`); it creates no identity/RBAC/session/config/audit tables (Inv. #9).
3. **Applied migrations** — forward-only; the overlap and CHECK constraints ship in the module's new migration, never by editing an applied one.
4. **Permission registry mechanism** — the `products` row (READ/EDIT/DELETE) comes only from the committed migration; no code path inserts PERMISSIONS rows.
5. **`tsconfig` strict flags, ESLint/Prettier, CI (`infra/**`)** — including the rename-invariance CI check; never weaken a gate to pass.
6. **Lockfiles/dependencies** — no DB extensions are needed (btree_gist requirement removed 2026-07-04); any npm dependency change is its own requested unit.
7. **Existing Administration routes, URLs, and authz results** — the rename must leave them byte-identical (Inv. #12).
8. **`TOREMOVE-Template-*` seed rows** — keep the prefix; never make production code depend on them; replacing them is a go-live data-migration task, not module code.
9. **The price repository's exported surface** — adding `update*`/`delete*` price functions is forbidden in every phase (Inv. #1).

If a unit genuinely requires touching any of these, stop, explain why, and get explicit confirmation.

## 7. Docs in Sync

Per the general doc §6, plus:

1. **Permission map** — a change to the page, its components, or the permission ships with the matching rows in `prodmgmt-architecture.md` §4 and `prodmgmt-code-standards.md` §8 in the same change set.
2. **Registry + map + guard together** — the `products` PERMISSIONS migration row, the map rows, the typed constant (`PERMISSIONS.PRODUCTS`), and the page guard land as one traceable set.
3. **Cross-module doc edits** — the rename and nav refactor update the already-planned one-line folder-ownership entries in `usrmgmt-architecture.md` §2 / `usrmgmt-code-standards.md` (overview *In Scope*); make no other edits to another module's docs without approval.
4. **Owning doc per fact:** product behavior → overview; schema/Invariant → architecture; convention/component names → code-standards; workflow → this doc. Reference, don't copy.
5. **Component names are binding** — create `ProductOfferingPage`, `OfferingTable`, `OfferingDetail`, `SpecificationsPanel`, `PricesPanel`, and the §4 indicator components exactly as named in code-standards §7–§8, or the page↔route↔component↔permission chain breaks.

## 8. Verification — Before the Next Unit

Run the full general doc §8 checklist, with these module readings and additions:

1. **Guardrail tests pass** — all seven in code-standards §9: authz matrix, price immutability (incl. structural assert of no update/delete exports), overlap constraint fails at the DB, derived effectivity (future-dated + open-ended `endDateTime: null`), JSONB/Zod validation (tier gaps/overlaps, `amount` XOR tiers), deep link (`?offering=` reproduces the view; unknown ID → empty-detail state), rename invariance.
2. **Authorization** — `requirePermission('products', 'READ')` at the top of the page; no-grant → no-access; no partial rendering of specs/prices under a weaker check (Inv. #10); deep links pass through the same guard.
3. **Audit** — confirm **no** `AUDIT_LOG` writes were added: reads are not audited in v1 (code-standards §1.3). The general §8.6 transaction rule is not yet in play.
4. **Data layer** — SQL only in `db/**`; constraints enforced by the DB, Zod additional (code-standards §6.4–§6.5); `created_at` and `start_date_time` both present and distinct on prices; no stored `end_date_time` anywhere (Inv. #3).
5. **URL state** — all list/selection state in searchParams, parsed never trusted, RETIRED hidden server-side by default, invalid params fall back to schema defaults (code-standards §3.2–§3.4).
6. **Read models** — services return `OfferingListRow` / `OfferingDetail` / `SpecificationCard` / `PriceCard`, not raw Drizzle rows (code-standards §2.7).
7. **Build gates** — `tsc --noEmit`, ESLint, Prettier, full test suite, SAST + DAST baseline clean; existing Administration pages green under `(app)` with identical URLs.
8. **No forbidden edits** — nothing from §6 above touched; no `actions/product/` or `app/api/product*` path exists; no `TODO`, commented-out code, or `console.*`.

If any item fails, the unit is not done. Fix it before moving on.
