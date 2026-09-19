# pm39 — Manage Products families list (read model + page rewrite)

**Unit:** pm39 (Part 3). **Boundary:** `db/repositories/product-offering.ts` (one new read), `services/product/list-families.ts`, `validation/product/family-list.schema.ts`, `app/(app)/products/manage-products/{page,loading}.tsx`, `components/products/manage/family-table.tsx`. No write path, no schema.
**Specs from:** `prodmgmt-update-overview.md` goals 1–2, criteria 1, 3 · `prodmgmt-code-standards.md` §1.16, §1.17, §2.9, §3.1–§3.5 · `prodmgmt-architecture.md` §2 (page row), §3.1 · plan D4, V9.
**Depends on:** pm37 (five-member `LifecycleStatus`, badges).

---

## Goal

Replace Manage Products' fetch-everything page with a server-paged list of product families built by one SQL query, so the first render issues exactly two statements (page + count) and no per-row detail fetch.

---

## Design

### D1. What one row is

One row per **family**, keyed by `COALESCE(family_offering_id, product_offering_id)` — the same expression pm36's indexes use. The row shows the family's **primary version**, chosen in this order: the `ACTIVE` version, else the open (`DRAFT` or `TESTING`) version, else the highest `version`. Both "else" branches are unique by pm36's indexes, so the choice is deterministic without a tiebreaker.

Columns: name, primary version's `LifecycleBadge`, version number, version count, sellable and billing-only chips, last modified. The open version's id travels on the row (`openVersionId`) so pm41's "edit" affordance can route to it without a second query.

### D2. Grouping happens in SQL

`findFamilyPage` is one statement with a CTE:

```
WITH fam AS (
  SELECT *,
         COALESCE(family_offering_id, product_offering_id) AS family_id,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(family_offering_id, product_offering_id)
           ORDER BY CASE lifecycle_status
                      WHEN 'ACTIVE' THEN 0
                      WHEN 'TESTING' THEN 1
                      WHEN 'DRAFT' THEN 1
                      ELSE 2 END,
                    version DESC
         ) AS rank,
         COUNT(*)      OVER (PARTITION BY COALESCE(...)) AS version_count,
         MAX(...)      OVER (PARTITION BY COALESCE(...)) FILTER (...) AS open_version_id
    FROM product.product_offering
)
SELECT … FROM fam WHERE rank = 1 AND <filters> ORDER BY name LIMIT … OFFSET …
```

`ACTIVE` sorts first, then the single open version, then everything else by version descending. The count query is the same CTE with `COUNT(*)` — two statements, not one, because the total must survive `LIMIT`. This reverses code-standards §2.9's "page-local grouping is simpler" call: it was simpler until it cost 3N queries.

### D3. Filters apply to the primary version

`q` matches the primary version's name (`ILIKE`); `status` matches the primary version's `lifecycle_status`. A family whose primary is `ACTIVE` does not appear under a `DRAFT` filter even if its draft exists — the list is a list of products, and the primary version is what represents one. The alternative (family matches if any version matches) makes the returned row inconsistent with the filter the user typed.

### D4. Manage Products shows every status

Unlike View Product (pm37 D4), the Manage list applies no default status exclusion — it is the administration surface, and an obsolete or retired family must be findable to be retired or inspected.

### D5. Page size reuses the existing config key

`products.offering_list_page_size` (`core.SYSTEM_CONFIG`, seeded at 5, 1–100 accepted). `listFamilies` resolves it through the same `resolvePageSize` logic `listOfferings` uses — extract that helper into a module-local shared function rather than copying it, and leave `listOfferings` behaviour unchanged.

### D6. Nine deletions

`fetchAllForStatus`, `fetchAllOfferingRows`, `fetchSpecificationsByOfferingId`, `mapWithConcurrencyLimit`, `groupIntoFamilies`, `selectPrimary`, `resolveFamilyId`, `MAX_COMBINED_ROWS` (all in `manage-products/page.tsx`) and `OfferingFamilyRow` (in `types/product.ts`). They go in this unit, not later — leaving them in place invites the next agent to call them.

---

## Implementation

### I1. `validation/product/family-list.schema.ts` (new)

`q` (trimmed, ≤ 100, `.catch('')`), `status` (`z.enum(LIFECYCLE_STATUSES).nullable().catch(null)`), `page` (coerced int ≥ 1, `.catch(1)`), `family` and `version` (both `/^PRDOFR\d+$/`, nullable, `.catch(null)`). Lenient by design, like `offering-list.schema.ts` — a tampered URL renders defaults, never a 500. `family`/`version` are parsed here but first consumed in pm40.

### I2. `db/repositories/product-offering.ts` — `findFamilyPage`

Implements D2 and returns `{ rows: FamilyListRow[]; total: number }`. Add `FamilyListRow` and `FamilyPage` to `types/product.ts` per code-standards §2.9. Keep `findList` untouched — View Product still uses it.

### I3. `services/product/list-families.ts` (new)

`listFamilies(params: FamilyListSearchParams): Promise<FamilyPage>` — resolve page size (D5), call the repository, return the page. Framework-agnostic, no `next/*`.

### I4. `app/(app)/products/manage-products/page.tsx`

Rewrite: `requirePermission(PRODUCTS, EDIT)` → await and parse `searchParams` → `Promise.all([listFamilies(params), getAppLocale(), getAppTimezone()])` → render `FamilyTable`. Keep `export const dynamic = 'force-dynamic'` and the existing `generateMetadata`. Perform the D6 deletions. The header copy changes to describe the new model: one row per product, selection opens its versions.

### I5. `components/products/manage/family-table.tsx` (new)

Server component. Reuses the Administration table primitives (search box, sortable header, pagination, empty state) — never a forked table. Each row is a `<Link>` rewriting `?family=` while preserving `q`, `status`, `page` (pm40 adds `version`). Columns per D1; `LifecycleBadge` from pm37; mono ids, `tabular-nums` on version and count. The row for a family whose primary is `OBSOLETE` or `RETIRED` renders muted per `prodmgmt-ui-context.md` §1.

**Two distinct empty states (design review, `prodmgmt-ui-context.md` §6).** (1) Fresh catalog (zero families, no filter): a warm `--surface-sunken` panel — "No products yet. Create the first offering to start the catalog." — referencing the header "New offering" CTA (do not re-render the accent button inside the empty state). (2) No search/filter match: a distinct state naming the query ("No products match \"`<q>`\"" and/or the active status filter) plus a quiet "Clear filters" action resetting `q`/`status`. The two must read differently so "no catalog yet" is never confused with "your filter hid everything."

### I6. `loading.tsx`

Reduce to the families-table skeleton. No panel skeletons — nothing loads until a family is selected.

### I7. `manage-offering-table.tsx`

Leave the file in place this unit **only if** the page no longer imports it; otherwise delete it together with its expand state. State explicitly in the PR which it was. (pm41 removes the dialogs it hosts; the table component itself has no consumer after I4.)

### I8. Tests

- `tests/db/product-family-page.integration.test.ts`: primary selection for a family with ACTIVE+DRAFT, one with DRAFT only, one with OBSOLETE+ACTIVE, one single-version family; `versionCount` and `openVersionId` correct in each; `q` and `status` filter on the primary; paging and total across 12 families at page size 5.
- `tests/app/manage-products-query-budget.test.ts` (new, the unit's headline proof): render the page against the test database with a statement counter installed on the pool; assert exactly two `product.product_offering` statements and **zero** statements against `product_specifications` or `product_offering_price`.
- Guardrail addition: `manage-products/page.tsx` contains none of the nine deleted identifiers (string-level assertion, so a reintroduction under the same name fails CI).

---

## Dependencies

**Packages to install: none.** The statement counter in I8 uses the existing `postgres` client's `onnotice`/debug hook or a `beforeQuery` wrapper already used by the integration harness — confirm which the harness exposes before writing the test, and add no query-logging library.

---

## Verification checklist

- [ ] Manage Products renders one row per family with the primary version's badge, version count and flags.
- [ ] First render issues exactly two statements and no per-row detail query (I8's assertion, not a manual count).
- [ ] Search and status filter run in SQL; paging works at the configured size; the total reflects families, not versions.
- [ ] Every lifecycle status is reachable on this page, including `OBSOLETE` and `RETIRED`.
- [ ] `openVersionId` is present exactly when the family has a `DRAFT` or `TESTING` version.
- [ ] All nine identifiers from D6 are gone; the guardrail proves it.
- [ ] `listOfferings` and View Product are byte-identical in behaviour; their tests pass unchanged.
- [ ] A tampered `?page=abc&status=NOPE` renders page 1 unfiltered rather than erroring.
- [ ] `tsc --noEmit`, ESLint, Prettier clean; no write path in this diff.

**Definition of done:** the page that used to issue hundreds of queries on first load issues two, and shows one row per product rather than a tree.
