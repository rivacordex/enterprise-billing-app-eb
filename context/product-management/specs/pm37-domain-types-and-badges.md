# pm37 — Domain types, total maps, lifecycle badges

**Unit:** pm37 (Part 3). **Boundary:** `types/**`, `components/products/*` (read-only side), `db/repositories/product-offering.ts` (default status filter only), plus the G2 literal fixes wherever the sweep found them. No service transition, no schema, no write path.
**Specs from:** `prodmgmt-code-standards.md` §2.1, §2.2, §3.5, §4.1 · `prodmgmt-ui-context.md` §0, §1 · `prodmgmt-architecture.md` Inv. #6, #17, #23 · plan D5, D12, V5.
**Depends on:** pm35 (the enum values exist in the database), G2 (the `'RETIRED'` literal audit).

---

## Goal

Widen `LifecycleStatus` to the five database values, force every union-keyed map to be total so the new members cannot fall through a default, render `TESTING` and `OBSOLETE` badges, and apply the G2 audit's app-code fixes so nothing outside the product module still reads `RETIRED` as "superseded".

---

## Design

### D1. Declaration order is lifecycle order and is load-bearing

`LIFECYCLE_STATUSES = ['DRAFT','TESTING','ACTIVE','OBSOLETE','RETIRED'] as const`. UI sort weight is the array index; the database enum (pm35) declares the same order so `ORDER BY lifecycle_status` in SQL and sorting in TypeScript agree. Nothing else may re-declare the order — a second list is a drift bug.

### D2. Total `Record`s, never a `default` branch

Every map keyed by a domain union becomes `Record<LifecycleStatus, T>`: badge variant, label, icon, row-muted flag, sort weight, and the allowed-actions map pm40–pm44 will consume. `tsc` then reports every site that has not considered `TESTING` and `OBSOLETE`. Any `switch` over the union ends with an exhaustive `never` check. Adding a `default:` to silence the compiler is a review-blocking defect — it is exactly the failure this unit exists to prevent.

### D3. The two new badges reuse existing token families

`TESTING` takes the info family (`#1A73D9` / `#0C4084` on `#E7F1FD`) with a `flask-conical` icon — the only lifecycle state that is neither a warning nor a terminal grey. `OBSOLETE` takes neutral-600 (`#4C5462`) with a `history` icon and a muted row; `RETIRED` keeps neutral-500 and `archive`. The two greys are one step apart deliberately: the icon and label carry the distinction, never colour alone (`prodmgmt-ui-context.md` §6).

### D4. View Product's default filter hides both terminal states

`buildWhereClause` in `product-offering.ts` currently excludes `RETIRED` when no status filter is given. It now excludes `OBSOLETE` **and** `RETIRED`. Rationale: the default View Product list answers "what can be sold", and an obsolete version is not sellable. Both remain reachable through the explicit status filter, which now offers five values (it derives from `LIFECYCLE_STATUSES`, so it widens for free). Manage Products does not use this query and is unaffected.

**This is a user-visible change to a shipped surface, not just a types change.** View Product (pm05–08) is already live; after this, a version superseded by an activation (pm42) silently drops out of its default list. Flag it in the release notes for this update, and **audit existing View Product tests for any default-list count/content assertion** — such a test breaks here (in a "types + badges" unit), which is not where a reader looks for a list-behaviour change. I6 adds the positive assertion; this bullet is the reminder to find and update the pre-existing ones.

### D5. Unit and period vocabularies land here, unused

`UNITS_OF_MEASURE = ['Mbps','GB','MB','EA'] as const`, `RECURRING_PERIOD_TYPES = ['months'] as const`, `RECURRING_PERIOD_LENGTHS = [1, 3, 12] as const`. They are declared in this unit, beside the other domain unions, and first consumed in pm38. Declaring them with the types rather than inside pm38's schema keeps §2.1's "defined once in `types/product.ts`" rule intact. Each carries a comment: widening these requires a migration changing the CHECK **and** a confirmed bm29 mapping.

---

## Implementation

### I1. `types/product.ts`

1. Widen `LIFECYCLE_STATUSES` per D1, with the order comment.
2. Add `UNITS_OF_MEASURE`, `UnitOfMeasure`, `RECURRING_PERIOD_TYPES`, `RecurringPeriodType`, `RECURRING_PERIOD_LENGTHS`, `RecurringPeriodLength` per D5.
3. Leave `PRICE_TYPES`, `PRICING_MODELS`, `EFFECTIVITY_STATUSES` and every read model unchanged. `FamilyListRow`, `FamilyPage` and `VersionSummary` belong to pm39/pm40, not here.

### I2. `components/products/lifecycle-badge.tsx`

Convert the variant lookup to `Record<LifecycleStatus, LifecycleBadgeVariant>` with all five entries, where a variant is `{ label, icon, fgToken, bgToken, muted }`. Tokens come from `globals.css` — no hex in the component (code-standards §4.3). Add `TESTING` and `OBSOLETE` per D3. Verify the component renders icon + label for every member.

### I3. `db/repositories/product-offering.ts`

In `buildWhereClause`, change the no-filter branch to exclude both `OBSOLETE` and `RETIRED`. Update the function's comment to state the rule and why. Touch nothing else in the repository — `findFamilyPage` arrives in pm39.

### I4. Total-map sweep

Run `tsc --noEmit` after I1 and fix every reported site. Expected list (confirm, do not assume it is complete):

- `components/products/lifecycle-badge.tsx` (I2)
- any sort-weight or label map in `components/products/offering-table.tsx` and `components/products/manage/manage-offering-table.tsx`
- `validation/product/offering-list.schema.ts` — no edit needed; its `z.enum(LIFECYCLE_STATUSES)` widens automatically. Confirm the status filter now accepts all five and still falls back to `null` on a bad value.
- any test fixture enumerating statuses

### I5. G2 literal fixes

Apply the audit's decisions to app code:

- Every `=== 'RETIRED'` / `!== 'RETIRED'` that meant "superseded or withdrawn" becomes a check against `OBSOLETE` **or** both, per the audit's per-site decision.
- Every "is this billable" check must accept `ACTIVE` **and** `OBSOLETE` (Inv. #6, #17).
- Every "is this orderable" check stays `ACTIVE`-only — confirm `services/ordering/order-preconditions.ts` and the offer picker still filter on `ACTIVE` alone and are therefore correct unchanged.
- **Re-derive the stale price-immutability rationale in `order-preconditions.ts` (owned here).** The existing comment at the price existence-check ("Insert-only (Inv. #1), so no lock is needed for this existence check to stay valid through the write below") is a correctness rationale, not a `'RETIRED'` literal, so the mechanical sweep would miss it — but pm38 makes prices mutable on DRAFT, so the words are now false in general. It stays *safe* (orders only touch `ACTIVE`, whose prices are immutable), so rewrite the comment to "immutable once the version leaves DRAFT; orders only touch ACTIVE" rather than changing behaviour. This unit owns the fix so it does not fall between the sweep and pm38.
- `workflow-management/**` findings are **reported, not edited** (that repo is read-only from here); they are carried into pm45's hand-off list.

Every site touched here gets a one-line comment naming the rule it now follows.

### I6. Tests

- `tests/types/product-unions.test.ts` (new): the five statuses in order; the unit and period vocabularies match pm35's CHECK values exactly (string equality against a list duplicated in the test on purpose, so a silent widening fails).
- `tests/components/lifecycle-badge.test.tsx`: extend to assert all five variants render a distinct icon + label pair and that muted rows carry the muted class.
- `tests/db/product-repositories.integration.test.ts`: the default View Product list excludes `OBSOLETE` and `RETIRED`; an explicit `status=OBSOLETE` filter returns them.

---

## Dependencies

**Packages to install: none.** `flask-conical` and `history` already ship with the installed `lucide-react`; confirm both exist in the pinned version before writing the map, and pick `beaker` / `clock-fading` only if one is genuinely missing.

---

## Verification checklist

- [ ] `LIFECYCLE_STATUSES` has five members in lifecycle order; no second list of statuses exists anywhere (grep for `'RETIRED'` in array literals).
- [ ] `tsc --noEmit` is clean and no `default:` branch or `as` cast was added to silence it.
- [ ] Every union-keyed map is a total `Record`; deleting one entry makes the build fail (prove it once, locally).
- [ ] View Product renders `TESTING` and `OBSOLETE` badges with distinct icons; both greys are distinguishable in light and dark.
- [ ] The View Product status filter offers all five values; the default list hides `OBSOLETE` and `RETIRED`; an explicit filter surfaces them.
- [ ] Every G2 app-code site is fixed and commented; `workflow-management/**` findings are recorded for pm45, not edited.
- [ ] Ordering's offer picker still filters `ACTIVE`-only and its tests pass unchanged.
- [ ] Full suite green, ESLint and Prettier clean.
- [ ] No schema, migration, service transition, action or write path changed in this unit.

**Definition of done:** a version set to `TESTING` or `OBSOLETE` in `psql` renders correctly on View Product with the right badge, the default list hides the obsolete one, and the compiler — not a code review — is what guarantees no map forgot the new statuses.
