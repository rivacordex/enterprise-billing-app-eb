# Product Management — Issues Tracker

Known, unresolved defects and debts in the Product Management module that are **not** owned by the unit currently in flight — a to-do list of things to come back and fix, distinct from `prodmgmt-progress-tracker.md` (which is the narrative build log). Each entry records what is broken, why, whose scope the fix belongs to, and exactly how to verify it once fixed.

**Status legend:** `OPEN` (unfixed) · `IN PROGRESS` (someone is on it) · `RESOLVED` (fixed + verified; keep the entry for history). Newest issues first.

---

## PM-ISS-001 — Product integration-test fixtures still insert the pre-pm46/pm47 price-row shape (8 suites red)

**Status:** OPEN. **Discovered:** 2026-09-24, running the product integration suites against the disposable test DB (`docker-compose.test.yml`, `.env.test`, port 5434) during the pm54/pm55 review-fix pass. **Severity:** medium — it blocks the pm46–pm54 G-E close-out (the DB-backed suite cannot go green), but ships no runtime defect: the app code and its DB-free unit/component suites are green; only stale **test fixtures** are wrong.

**Symptom.** The product-module integration suites are red against a correctly-migrated test DB — **67 failing / 92 passing across the 13 product files (8 files red, 5 green)** — the 13 that existed at the time of the run; pm57 has since added a 14th (`tests/db/product-ratecard-schema.integration.test.ts`), which is new-shape and unaffected by this drift but has not itself been run against a live database yet (see the pm57 entry in `prodmgmt-progress-tracker.md`):

| Suite | Result | Failure family |
| --- | --- | --- |
| `tests/db/product-price-writes.integration.test.ts` | 10 / 10 failed | `component_type` NOT NULL on fixture insert |
| `tests/db/product-withdrawal-path.integration.test.ts` | 13 / 13 failed | `component_type` NOT NULL on fixture insert |
| `tests/db/product-release-path.integration.test.ts` | 14 / 16 failed | `component_type` NOT NULL on fixture insert |
| `tests/db/product-price-constraints.integration.test.ts` | 10 / 11 failed | `component_type` NOT NULL on fixture insert |
| `tests/db/product-delete-offering.integration.test.ts` | 6 / 7 failed | `component_type` NOT NULL on fixture insert |
| `tests/db/product-family-guards.integration.test.ts` | 13 / 20 failed | raw-SQL fixtures reference dropped `price_type` (flagged earlier by pm49) |
| `tests/db/product-schema.integration.test.ts` | 1 / 8 failed | asserts the dropped `(product_offering_id, price_type, start_date_time)` unique key |
| `tests/db/product-repositories.integration.test.ts` | 0 tests (collection error) | file is `tsc`-red — the documented "option-C co-land" file |

Representative error:

```
PostgresError: null value in column "component_type" of relation
"product_offering_price" violates not-null constraint
  ❯ newActiveOffering  tests/db/product-withdrawal-path.integration.test.ts:153
```

**Root cause.** pm46 dropped the row-level `price_type` / `amount` / `pricing_model` columns and pm47 replaced them with a **NOT NULL `component_type`** + a JSONB **`price_component`** envelope. These suites' fixture helpers (`newActiveOffering`, `newObsoleteOffering`, the raw-SQL price inserts, etc.) were never updated — they still insert the old column set, so the row fails the NOT NULL check (or, in `product-schema`/`product-family-guards`, assert/select a column that no longer exists). `product-repositories` additionally cannot even compile against the new `PriceCard` shape (0 tests collected).

**Why this is not a pm54/pm55 (or review-fix-pass) regression.** All eight failing files are DB-layer test fixtures; the pm54/pm55 work and the 2026-09-24 review-fix pass touched only client components (`components/products/manage/*.tsx`) and their component tests — no DB, schema, service, repository or fixture file (`git status` confirms). The files are byte-identical to `HEAD`, so these failures predate the session. The progress tracker already predicts this exact drift — see the pm35 "option-C co-land" directive, the pm36/pm50/pm51 fixture-reshape notes, and the pm49 open-flag that first caught `product-family-guards` red.

**The pattern to copy (the 5 green suites already do it).** `product-price-components`, `product-price-component-constraints`, `product-seed-components`, `product-family-page`, and `manage-products-query-budget` insert the pm47 shape correctly and pass. The reference for a correct fixture write is `db/seeds/demo/product-demo.ts` (branch DRAFT → insert the discriminated `price_component` → flip ACTIVE) and `tests/db/helpers/billrun-aggregate.ts` (parse each envelope through `persistablePricingComponentSchema` before `JSON.stringify`).

**Fix owed (two axes, per the option-C note).** For each red suite, reshape every `product_offering_price` insert to (1) supply `component_type` + a schema-valid `price_component` envelope (pm47's discriminated union), and (2) insert-while-DRAFT-then-activate wherever the pm36 §3.5 DRAFT-guard trigger applies; update `product-schema`'s unique-key assertion to the current `(product_offering_id, component_type, unit_of_measure, start_date_time)` shape and drop the `price_type` references in `product-family-guards`. This is the "option-C co-land" debt — it belongs to whichever unit next reworks these fixtures, or to an explicit sweep, not to the UI authoring units.

**Verify when fixed:**
```
docker compose -f docker-compose.test.yml up -d --wait
node --env-file=.env.test node_modules/vitest/vitest.mjs run \
  --config vitest.integration.config.ts product
docker compose -f docker-compose.test.yml down -v
```
Expect all 13 product files green (14 including pm57’s new rate-card suite, which needs a first live run rather than a fixture repair). (A full close-out also needs the same sweep applied to the non-product integration suites the tracker lists — ordering/rating/billing fixtures with the identical drift — before the pm46–pm54 G-E green claim can be made.)
