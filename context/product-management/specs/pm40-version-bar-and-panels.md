# pm40 — Version bar + read-only panels on Manage Products

**Unit:** pm40 (Part 3). **Boundary:** `db/repositories/product-offering.ts` (one read), `services/product/list-family-versions.ts`, `app/(app)/products/manage-products/page.tsx`, `components/products/manage/version-bar.tsx` and the three panel wrappers. No write path.
**Specs from:** `prodmgmt-update-overview.md` goal 1, flow steps 3–4, criterion 2 · `prodmgmt-code-standards.md` §3.2–§3.5, §4.4, §4.16 · `prodmgmt-architecture.md` §2 (`components/products/**` row), Inv. #29 · plan D4.
**Depends on:** pm39 (families list and the `?family=` selection it emits).

---

## Goal

Selecting a family on Manage Products shows that version's detail, specifications and prices in place — closing the update's primary complaint — with a version bar that switches between versions in one click and three queries.

---

## Goal-adjacent non-goal

Nothing on this page is editable yet. pm40 renders; pm41 edits. Keeping them apart means the read path's query budget is provable before edit affordances exist to muddy it.

---

## Design

### D1. Selection is two searchParams, and `version` is subordinate to `family`

`?family=PRDOFR…&version=PRDOFR…`. Resolution order in the page:

1. No `family` → render the table plus the empty-selection state. No panel queries run.
2. `family` present, `version` absent → select the family's primary version (the same rule pm39 D1 uses).
3. `family` and `version` present, `version` belongs to that family → select it.
4. `version` does not belong to the family (stale link, hand-edited URL) → fall back to the primary version silently. Not a 404, not an error boundary (code-standards §3.3).
5. `family` matches no row → empty-selection state with a muted "That product no longer exists" line.

### D2. The version bar is a row of links, not a dropdown

One compact entry per version: `v3` + `LifecycleBadge`. The selected entry carries `--surface-selected`; the others `--surface-sunken`. Ordered by version descending, so the newest work sits left. A family with one version renders that single entry — never an affordance implying more (`prodmgmt-ui-context.md` §6). Each entry is a `<Link>` rewriting `?version=` and preserving `q`, `status`, `page`, `family`.

**Overflow at scale (design review).** A long-lived family can hold many versions. The bar **scrolls horizontally with an edge-fade** when entries exceed the width; it never wraps to stacked rows (that pushes the panels down unboundedly). Descending order puts the **newest** version at the left edge — the open `DRAFT`/`TESTING` version when the family has one (a branch is `MAX(version)+1`, so it outranks the `ACTIVE` version by number), otherwise the `ACTIVE`/highest version — so the version a user most likely wants sits left, visible without scrolling; the `ACTIVE` version is not guaranteed to be the leftmost when an open draft precedes it. Links stay tab-navigable; the h-scroll is pointer/trackpad plus keyboard-focus-scroll (a focused off-screen link scrolls into view natively) — no custom key handler, no `tablist` (`prodmgmt-ui-context.md` §7).

A dropdown would hide the shape of the family — how many versions exist and what states they are in is exactly what a Revenue Ops user opens this page to see.

### D3. Panels reuse View Product's components

`OfferingDetail`, `SpecificationsPanel` and `PricesPanel` are imported from `components/products/*` and rendered inside Manage's layout (Inv. #29 — the import is one-directional and correct; the converse stays forbidden). Any prop they need that they do not have is added to them **without** changing their read-only behaviour, and that addition is called out in the PR. Duplicating them into `manage/` to avoid the import is the defect this invariant exists to prevent.

### D4. Layout

The `lg:` grid from View Product, with the version bar inserted between table and detail: table (full width) → version bar → detail → specifications and prices side by side; stacking to a single column in that order on narrow viewports (`prodmgmt-ui-context.md` §7).

### D5. Query budget

A `?family=`/`?version=` change re-renders the **whole route**, so the page re-runs every read in its render path, not just the panels. The per-selection budget therefore depends on one caching decision, which this unit must make and record:

- **`findFamilyPage` (the families table, 2 statements) is re-run on every selection and version switch unless it is held in the Next Data Cache** keyed by `q`/`status`/`page`. Decide here whether to cache it. Cached ⇒ the table's 2 statements are paid once per filter, not once per selection.
- With the families list cached: selection = family versions + offering detail (offering, specs, prices) = **4**; switching version re-runs family versions + detail = **4** as well (the version list is re-fetched by the render; if it too is cached per `family`, switch = **3**).
- Without caching: add the table's 2 to each of the above.

Pick one design, write the exact resulting integers, and assert them — no "three or four" range (a loose range lets a real +1 regression pass). The pm39 budget test is extended with the chosen numbers rather than replaced, and pm45 D4's post-mutation case uses the same accounting.

**Decision (recorded — uncached).** `findFamilyPage` is **not** held in the Next Data Cache. Rationale: (1) the platform/module architecture mandates no cache layer (architecture.md §1, prodmgmt-architecture §1 — the repo has zero `unstable_cache`/`use cache`/`cacheComponents`); (2) the wrap would live in `list-families.ts`, outside this unit's boundary; (3) the shipped mutation actions revalidate by **path** (`revalidatePath`), not tag, so a cached entry would need `revalidateTag` wiring (a write-unit concern) and would otherwise serve a stale families list; (4) the query-budget integration test renders by direct function call with no Next incremental-cache context, so Next Data Cache is not demonstrable there. **Resulting integers (asserted): no selection = 2; selection = 6; version switch = 6** (families 2, always paid + versions 1 + `getOfferingDetail` 3). The "= 4" figures above describe the *cached alternative* and are not the chosen design. A well-formed but unknown `?family=` costs **3** (families 2 + versions 1; no detail). pm45 D4 inherits this uncached accounting.

---

## Implementation

### I1. `db/repositories/product-offering.ts` — `findFamilyVersions`

`(db, familyId) => VersionSummary[]`, one query: `WHERE COALESCE(family_offering_id, product_offering_id) = $1 ORDER BY version DESC, product_offering_id ASC`. The `product_offering_id ASC` tie-breaker keeps the order deterministic and matches `findList`/`findFamilyPage`'s stable-ordering convention; `version` is unique within a family (Inv. #8), so it only bites on a data anomaly, but the order feeds `resolveSelectedVersion`'s "highest version" fallback. Returns `{ productOfferingId, version, lifecycleStatus, lastModified }`. Add `VersionSummary` to `types/product.ts`.

### I2. `services/product/list-family-versions.ts` (new)

Thin pass-through with an explicit return type, framework-agnostic. It exists so the page never touches a repository (architecture §2's boundary rule), not because it holds logic.

### I3. `app/(app)/products/manage-products/page.tsx`

Extend pm39's page: when `params.family` is set, `listFamilyVersions(family)` runs concurrently with `listFamilies` in the page's `Promise.all` (neither depends on the other). Then resolve the selected version with the pure helper `resolveSelectedVersion(versions, requestedVersionId)` (D1's resolution order, unit-tested on its own), and only then `getOfferingDetail(resolvedVersionId)` for the resolved id — it already returns offering + specifications + prices with derived effectivity, so no new read is written for the panels. The version list and the detail read **cannot** share one `Promise.all`: the detail read depends on the resolved id, which is not known until the version list has been fetched and resolved (this is the sequential step, not the concurrent one).

### I4. `components/products/manage/version-bar.tsx` (new)

Server component per D2. `aria-current="page"` on the selected entry; `aria-label` per link reading "Version 3, active".

### I5. Panel composition

A small `manage/selection-region.tsx` server component composing detail + specifications + prices inside the D4 grid, so `page.tsx` stays a thin orchestrator. It renders the View Product components directly; it holds no state and no business rules.

### I6. Empty and edge states

- No family selected: `--surface-sunken` panel, "Select a product to see its versions, specifications and prices."
- Family with no specifications yet: the existing empty state from `SpecificationsPanel`.
- Family with no prices yet: the existing empty state, plus "At least one price is required before this version can be submitted for testing" when the selected version is `DRAFT` (the hint pm42 will act on).

### I7. Tests

- `tests/services/resolve-selected-version.test.ts`: all five D1 cases.
- `tests/app/manage-products-selection.test.tsx`: selecting a family renders specs and prices; switching version re-renders the panels; a `?version=` from another family falls back to the primary; an unknown `?family=` renders the empty state.
- Extend `tests/app/manage-products-query-budget.integration.test.ts` (the `.integration.` variant, so the DB-backed project picks it up) with D5's numbers, including "no selection ⇒ still two statements".
- Guardrail: `components/products/*.tsx` still imports nothing from `manage/` (guardrail 11 unchanged, and it must not be relaxed by this unit's new import direction).

---

## Dependencies

**Packages to install: none.**

---

## Verification checklist

- [ ] Selecting a family shows its versions, and the selected version's detail, specifications and prices, without leaving the page.
- [ ] Prices show amount or tiers, currency, GL code, charge period or unit, start date, derived end and effectivity state.
- [ ] Deep links reproduce the exact view; the four D1 fallbacks behave as written and none 404s.
- [ ] Version bar: newest first, selected entry marked, single-version family shows one entry with no extra affordance.
- [ ] Query budget (uncached design, D5): no selection = 2 statements; selection = 6; version switch = 6; well-formed-but-unknown `?family=` = 3. (The "= 4" figure was the cached alternative, which D5 explicitly rejected.)
- [ ] Manage imports View's read-only components; guardrail 11 still passes in its original direction.
- [ ] Layout stacks table → version bar → detail → specs → prices on narrow viewports.
- [ ] `tsc --noEmit`, ESLint, Prettier clean; no mutation, action or schema change in this diff.

**Definition of done:** a Revenue Ops user answers "what does this product charge, and which version is live?" entirely on Manage Products.
