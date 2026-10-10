# Product Management — Issues Tracker

Known, unresolved defects and debts in the Product Management module that are **not** owned by the unit currently in flight — a to-do list of things to come back and fix, distinct from `prodmgmt-completed-tracker.md` (the per-unit build record). Each entry records what is broken, why, whose scope the fix belongs to, and exactly how to verify it once fixed.

**Status legend:** `OPEN` (unfixed) · `IN PROGRESS` (someone is on it) · `RESOLVED` (fixed + verified; keep the entry for history). Newest issues first.

---

## PM-ISS-004 — The price lane key expression is copied into four places

**Status:** **RESOLVED (2026-10-10, option B — guardrail 41).** See the Resolution note at the end of this entry. **Discovered:** 2026-10-10, `/code-review xhigh` of `efaff82..HEAD`. **Severity:** low — no current defect; a drift risk.

**Symptom.** pm46a's lane key `(product_offering_id, component_type, unit_of_measure, CASE WHEN component_type = 'flat_fee' THEN price_component ->> 'priceType' END)` is written out by hand in `0049_product_price_lane_key.sql`, the Drizzle `uniqueIndex` in `db/schema/product.ts`, the repository's `lead()` window (`db/repositories/product-offering-price.ts`), and, in an equivalent flat-fee-only form, the bill-run recurring resolver. They are kept in step by comments and guardrail 13's exact-string match.

**Risk.** The next lane change (e.g. a new component type that varies by `priceType`) must edit all four consistently; a reader that misses it misjudges supersession, the defect pm46a fixed.

**Options considered.** (A) One IMMUTABLE SQL function (e.g. `product.price_lane_type(component_type, price_component)`) used by the index and every reader. Rejected for now (Khek, 2026-10-10): changing the function later still needs a migration plus a `REINDEX` (an index built on an IMMUTABLE function is not recomputed when the body changes), `billrun_runtime` would need EXECUTE on a `product` function, it is cross-domain and gated again, and rating's deliberately narrower key (rm20) could not use it. Worth revisiting if a new component type ever varies by `priceType`. (B) A guardrail that keeps the copies honest — **chosen**. (C) Leave open.

**Resolution (2026-10-10, option B).** Product **guardrail 41**, `tests/guardrails/price-lane-key-consistency.test.ts` (DB-free): (1) the three definition sites (`0049`, the Drizzle mirror, the repository's lane-term constant) spell the term identically; (2) every `PARTITION BY … component_type …` window under `db/`, `services/`, `lib/`, `app/` and `workflow-management/` (comments blanked) must partition on the lane key, or on a form proven equal for the component types it scans (raw `priceType` on a flat_fee-only scan; no term on a scan without flat_fee), or be a listed exception (rating's `rp.py`, rm20); (3) the inventory of such windows is pinned (repository 1, bill-run flow 3, `rp.py` 1), so a new reader must be reviewed. The real code was verified, then three deliberate breaks were each caught at the right line: the repository window losing its term, the flow's recurring window losing its `priceType`, and a capacity window starting to scan `flat_fee`.

---

## PM-ISS-003 — Recurring and one-time flat fees share one lane, so a one-time fee supersedes the monthly fee

**Status:** **RESOLVED (2026-10-10, pm46a).** See the Resolution note at the end of this entry. **Owner:** pm46a (`specs/pm46a-flat-fee-lane-key.md`). **Discovered:** flagged by pm46 itself ("Known gap, flagged for follow-up") and carried by pm49; surfaced as a real failure on 2026-10-10 when the full integration project ran (`billmgmt-known-issues.md` §21e). **Severity:** medium-to-high. A common offering shape (monthly fee + activation fee) reads and bills wrongly.

**Symptom.** The lane `(product_offering_id, component_type, unit_of_measure)` puts every `flat_fee` (unit always NULL) in one lane, whatever its envelope `priceType`. A one-time fee dated after a recurring one ends it: the order detail shows no recurring line (4 failing `ordering-read` tests), the offering detail shows the monthly fee as Superseded, and the bill run fails the account HARD with `RECURRING_PRICE_UNSUPPORTED` unless a recurring override exists. The unique constraint on the same key also forbids the two fees starting on one date, which is why the demo seed and fixtures offset the Activation Fee by a day.

**Fix.** pm46a: add `price_component ->> 'priceType'` to the lane key in a forward migration (unique index, `NULLS NOT DISTINCT`), the repository's `lead()` window and the bill-run recurring resolver.

**Resolution (2026-10-10, pm46a).** `0049_product_price_lane_key.sql` drops `product_offering_price_component_start_unique` and creates `product_offering_price_lane_start_unique`; the repository window and the bill-run resolver partition on the same key, and `RECURRING_PRICE_UNSUPPORTED` is retired. The four `ordering-read` tests pass unchanged; new tests cover both orderings and the same start (repository and `getOfferingDetail`), the insert path's `DUPLICATE_START`, a one-time fee at the recurring fee's start, and the bill run billing the recurring price beside a later or same-start one-time fee. Full integration project 1165 passed / 0 failed; full unit suite 4077 passed / 0 failed.

---

## PM-ISS-002 — Rate-card lookup-row immutability (Inv. #46) is not database-enforced

**Status:** **OPEN.** **Owner:** pm57a (the schema unit) or a follow-up migration — **not** pm60. **Discovered:** 2026-09-27, building the pm60 card repository and confirming guardrail 37's database arm. **Severity:** low-to-medium — no runtime defect in the shipped Part-5 code (no consumer writes a lookup row outside the repository, and the repository exports no row-level lookup write), but the defense-in-depth the design assumes is absent.

**Symptom.** `db/migrations/0041_ratecard_ran_usage_lkp.sql` (pm57a) creates `product.ratecard_ran_usage_lkp` with the row-key uniqueness constraint and the cascade FK, but **no trigger, rule or revoke**. `app_runtime` holds full DML on the `product` schema (`bootstrap-db-roles.sql`'s schema-wide grant). So a **direct** `UPDATE`/`DELETE` against a lookup row of an `ACTIVE` version **succeeds** — Postgres does not refuse it. Inv. #46 ("a lookup row is only ever inserted or removed by cascade — never edited or deleted directly") is therefore enforced in the current tree **only by the repository's exported surface** (guardrail 37's exported-surface arm, `tests/db/product-repository-exports.test.ts`, green), not by the database.

**Why it belongs to pm57a, not pm60.** pm60-spec I3 is explicit: "if a trigger is required, that is a pm57a finding to raise, not a trigger to add here" (workflow §5.7 — a guardrail's need must not invent a schema object in the wrong unit). pm60 owns the repository surface, not the DDL.

**Fix.** In pm57a (or a forward migration once `0041` is immutable in `main`), add a trigger analogous to product's `child_write_requires_draft` (`0040_product_family_guards.sql`) that refuses an `UPDATE`/`DELETE` of a `ratecard_ran_usage_lkp` row whose parent version is not `DRAFT` — or, more strictly, refuses any row-level `UPDATE`/`DELETE` outright (a lookup row is never edited; a version is discarded whole via the cascade). Leave `deleteDraftVersion`'s parent-row cascade path permitted.

**Verify once fixed.** Flip `tests/db/ratecard-repository.integration.test.ts`'s `[FINDING pm57a] …` test from asserting the raw `UPDATE`/`DELETE` **succeeds** to asserting it is **rejected** (guardrail 37's database arm), against a database built from empty.

---

## PM-ISS-001 — Product integration-test fixtures still insert the pre-pm46/pm47 price-row shape (8 suites red)

**Status:** **RESOLVED (2026-09-24, pm56a).** Fixed by the pm56a fixture sweep (`specs/pm56a-fixture-sweep.md`) — see the Resolution note at the end. **Owner:** pm56a. **Discovered:** 2026-09-24, running the product integration suites against the disposable test DB (`docker-compose.test.yml`, `.env.test`, port 5434) during the pm54/pm55 review-fix pass. **Severity:** medium — it blocked the pm46–pm54 G-E close-out (the DB-backed suite could not go green), but shipped no runtime defect: the app code and its DB-free unit/component suites were green; only stale **test fixtures** were wrong.

**Symptom.** The product-module integration suites are red against a correctly-migrated test DB — **67 failing / 92 passing across the 13 product files (8 files red, 5 green):**

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

**Fix owed (two axes, per the option-C note).** For each red suite, reshape every `product_offering_price` insert to (1) supply `component_type` + a schema-valid `price_component` envelope (pm47's discriminated union), and (2) insert-while-DRAFT-then-activate wherever the pm36 §3.5 DRAFT-guard trigger applies; update `product-schema`'s unique-key assertion to the current `(product_offering_id, component_type, unit_of_measure, start_date_time)` shape and drop the `price_type` references in `product-family-guards`. This is the "option-C co-land" debt — now scoped as **pm56a** (`specs/pm56a-fixture-sweep.md`), an explicit `tests/**` sweep, not the UI authoring units. (The ordering-wizard production chain is the separate **pm56b**; the two together are what turn guardrail 31 green.)

**Verify when fixed:**
```
docker compose -f docker-compose.test.yml up -d --wait
node --env-file=.env.test node_modules/vitest/vitest.mjs run \
  --config vitest.integration.config.ts product
docker compose -f docker-compose.test.yml down -v
```
Expect all product files green. (A full close-out also needs the same sweep applied to the non-product integration suites the tracker lists — ordering/rating/billing fixtures with the identical drift — before the pm46–pm54 G-E green claim can be made.)

**Resolution (2026-09-24, pm56a).** The eight red files are green or gone: six repaired in place to the `component_type` + `price_component` envelope (`product-withdrawal-path`, `product-release-path`, `product-delete-offering`, `product-family-guards`, `product-schema.integration`, `product-repositories.integration`); two deleted as superseded with their unique cases migrated into the already-green suites (`product-price-writes` → `product-price-components`'s new `DUPLICATE_START` + raw-SQL trigger cases; `product-price-constraints` → `product-price-component-constraints`'s new `period_value_check` + `unit_value_check` cases). **Verified against the disposable test DB from empty: `product-*.integration.test.ts` = 11 files / 166 tests, all green.** The product count is now **11** (13 − 2 superseded), not 13. `product-schema.integration`'s table/sequence assertion was also updated for pm57's two rate-card tables. The non-product integration suites with the identical drift (ordering/rating/billing) remain for their own sweeps before the G-E close-out.
