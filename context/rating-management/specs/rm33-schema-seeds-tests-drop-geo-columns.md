# rm33 — Drop the columns: `0045` rewrite, Drizzle, seeds, tests — Spec

- **Unit:** rm33 of Phase J (`rm00-build-plan.md`)
- **Repo:** `enterprise-billing-app` (app surface) · **Boundary:** `db/migrations/0045_rating_udr_rated_geo.sql` (rewritten in place), `db/migrations/README.md` (one dated note), `db/schema/rating/udr-rated.ts`, `db/seeds/sample/udr-rated-sample.ts`, `db/seeds/sample/seed-billrun-sample.ts`, `tests/rating/rm01-schema`, `tests/rating/grants`, `tests/rating/rm23-udr-geo-frozen`, `tests/e2e/invoice-template-journey.integration.test.ts` (raw INSERT + one comment), `tests/guardrails/invoice-render-source-boundary.test.ts` (one comment). Billing suites are **run**, not edited.
- **Authorizes from:** `_change-rating-drop-udr-rated-geo-columns-plan.md` D1, D4, D5, D6, D7, D9 and §3, §5; `ratemgmt-architecture.md` Inv 2, 26 (reversal note), 28; `ratemgmt-code-standards.md` §0.1 data rules 1 and 3 (reversal notes); `ratemgmt-ai-workflow-rules.md` §0.1 rule 17 (one-time exception), rule 21 (billing owner told).
- **Depends on:** rm32 **deployed** (the worker image no longer COPYs the columns). An older image COPYing into a database built from the rewritten `0045` fails at `COPY` (42703), so the first release after this unit ships with `buildRatingEngine=true` and a database created fresh on that release.

## Goal

Remove `udr_rated.state` and `udr_rated.district` from the schema, the Drizzle model, the sample seeds and every test that asserts on them, and prove that `udr_resource` alone still carries the frozen geo end to end — on a fresh database, this round only.

## Design

- **`0045` is rewritten in place, not followed (plan D4, this round only).** The file becomes a single statement, `ALTER TABLE "rating"."udr_rated" DROP COLUMN IF EXISTS "state", DROP COLUMN IF EXISTS "district";`, with a header comment stating that bm48 was reversed on 2026-10-27 under the fresh-DB setup and that any later removal is a forward migration. The journal entry stays (idx 45, `tag`, `when` unchanged); drizzle's migrator keys on `when`, so a fresh database runs the rewritten file (a no-op: the columns never existed) and no new migration number is consumed. **Known and accepted:** a database that already applied the original `0045` skips the rewritten file (`db/migrations/README.md` rule 4; APP-03) and keeps the columns — which is why D5 requires every environment to be created fresh on this release. There is no production (owner, 2026-10-27).
- **`DROP COLUMN IF EXISTS`, not an empty file.** An empty migration is an edge case for the SQL splitter; a no-op DROP is an ordinary statement, cascades to every partman child if a column ever exists, and reads as what it is.
- **The rule is kept, the exception is dated.** `db/migrations/README.md` rule 4 gets one dated sentence (same form as its existing `0006_product.sql` note): `0045` rewritten 2026-10-27 for the Phase J fresh-DB round; forward migrations remain the rule. `ratemgmt-ai-workflow-rules.md` rule 17 already carries the matching note (rm31).
- **No grant change (D6).** The columns had none of their own; `rating-db-roles.sql` is untouched (`:91-93` are table-level). `check:rating-migration-boundary` and `tests/rating/rm13-migration-boundary.test.ts` are filename-regex based and pass on the rewritten file unchanged.
- **Seeds bypass rating, so they must drop the fields themselves and still write `udr_resource`.** Today `sampleRanGeo` (`seed-billrun-sample.ts:1456-1470`) returns `{ state, district }` only, so every non-capacity seeded RAN row has `NULL` `udr_resource` and would render blank State/District once the columns are gone (outside-voice finding 4). It becomes the single source of the row's geo: `{ udrResource }` built with `formatUdrResource({ state, district, polygonStartDate: SAMPLE_5G_START_DATE })` from `SAMPLE_RAN_GEO_LABELS`, `null` for `SAMPLE_NULL_GEO_SEQUENCE` (the "Unassigned region" fixture). The capacity path already builds `udrResource` from the card cell (`cardLabelFor`, `:1515-1527`) and only loses the two fields. `SAMPLE_RAN_GEO_LABELS` (`udr-rated-sample.ts:68-78`) stays as that input.
- **Tests change kind, not count.** `rm01` 15b asserts **absence** (the natural home — it is the schema test); `grants` 10a asserts privileges on `udr_resource` only (a `has_column_privilege` call on a dropped column raises, it does not return `false`); `rm23` keeps its name and its two cases, re-scoped to `udr_resource` — the re-version case (`:202-247`) is its unique proof, the UPDATE-refusal case (`:249-262`) keeps the `udr_resource` column only.
- **Billing is touched in two comments and one raw INSERT, all in test files** (rule 21, billing owner told): `invoice-template-journey.integration.test.ts:475-481` inserts `state, district` directly into `rating.udr_rated` and would fail with 42703; the comment at `:452` and `invoice-render-source-boundary.test.ts:7` still describe the bm49 read. No billing source file changes; `rated-lines.repository.ts` already reads `udr_resource`.
- **Release coupling (D7).** `infra/azure-pipelines.yml` rebuilds the worker only when `buildRatingEngine=true`; the migrate stage runs on every deploy. The first deploy after this unit sets the flag, and the database is created fresh on that release. No `rating_engine_version` bump is required (row semantics unchanged); bumping it is optional operator hygiene.
- **Out of scope:** any change to `udr_resource`; a forward migration (none this round); a backfill or rebuild list; a hash-drift check; a pipeline guard; a "stays gone" guardrail; `tests/db/helpers/billrun-capacity-pricing-fixtures.ts:312-313` and `capacity-polygon-fixtures.ts:30-34` (they are `formatUdrResource` inputs, not row fields — no change).

## Implementation

### 1. Migration and Drizzle
- `db/migrations/0045_rating_udr_rated_geo.sql`: replace the body with a header comment (bm48 reversed 2026-10-27, Phase J, fresh-DB round, forward migrations thereafter) and the one `ALTER TABLE … DROP COLUMN IF EXISTS "state", DROP COLUMN IF EXISTS "district";` statement. Remove the two `COMMENT ON COLUMN` statements. `meta/_journal.json`: **no change**.
- `db/migrations/README.md` rule 4 (`:34-46`): one dated sentence recording the exception and its scope.
- `db/schema/rating/udr-rated.ts:152-156`: delete the comment and the two `text()` fields. Nothing else in the file references them (the constraints at `:158-180` do not).

### 2. Seeds
- `db/seeds/sample/udr-rated-sample.ts`: remove `state?`/`district?` from the spec (`:60-61`) and `state:`/`district:` from the returned row (`:189-190`); rewrite the comment at `:57-59` (the row's geo is `udrResource`, `formatUdrResource` of its card cell; `NULL` = not on any card). Keep `SAMPLE_RAN_GEO_LABELS` and its comment (`:68-78`), reworded to say the labels feed `udrResource`.
- `db/seeds/sample/seed-billrun-sample.ts`:
  - `sampleRanGeo(sequence)` (`:1460-1470`) returns `{ udrResource: string | null }`: `null` for `SAMPLE_NULL_GEO_SEQUENCE`, otherwise `formatUdrResource({ state: label.state, district: label.district, polygonStartDate: SAMPLE_5G_START_DATE })`. Both call sites (`:1416`, `:1446`) spread it unchanged. Comment `:1456-1459` reworded.
  - Capacity anchor specs (`:127-161`): `CapacityAppendixCell.state`/`.district` **stay** — they are card inputs from which the capacity row's `udrResource` label is built (`formatUdrResource` of the card cell); only the fields written to `udr_rated` go. `cardLabelFor` (`:1462-1469`) keeps its behaviour and returns the cell's `udrResource` only; the insert (`:1524-1525`, `:1554-1563`) loses the two fields. The `POLY-APX-UNMAPPED` row stays `NULL`. Comments at `:102`, `:1483`, `:1510` reworded.
  - Import `SAMPLE_5G_START_DATE` from `sample-5g-fixture` if not already present (the pm67 seed-boundary guardrail allows the fixture module; it forbids naming the **card** module — unchanged).

### 3. Tests
- `rm01-schema` 15b (`:390-426`): rename to "udr_rated carries nullable text udr_resource and no state/district on the parent and on a partition (Phase J)"; the `column_name IN (...)` list becomes `('state', 'district', 'udr_resource')` with the expectation `[{ column_name: "udr_resource", … }]` only (so an accidental re-add fails), on the parent and the first partition.
- `grants` 10a (`:343-376`): loop over `["udr_resource"]` only; the `column_privileges` query lists `'udr_resource'`; the `rating_runtime` INSERT fixture loses `state`/`district`. Add one line: `pg_attribute` for `rating.udr_rated` contains neither `state` nor `district` (`attisdropped = false`).
- `rm23-udr-geo-frozen`: `readGeo` (`:142-165`) selects `udrResource` only and the map value becomes a string; the re-version case (`:202-247`) asserts the already-rated row's `udr_resource` is unchanged and the re-rate carries the revised labels in segments 1–2 with the same start date; the UPDATE-refusal loop (`:260`) becomes `["udr_resource"]`; the `reversionCard` INSERT (`:188`) still writes `state`/`district` **on the card** (unchanged — those are rate-card columns). File comment `:33` reworded.
- `tests/e2e/invoice-template-journey.integration.test.ts`: remove `state, district` from the column list and the matching two values from the `SELECT` at `:475-481`; reword the comment at `:452`.
- `tests/guardrails/invoice-render-source-boundary.test.ts:7`: comment only.
- `tests/rating/rm13-migration-boundary.test.ts`: no change expected; run it.

### 4. Run-only regression suites
`tests/db/billing-e2e-happy-path`, `billrun-capacity-*`, `billrun-recurring-aggregation`, `invoice-capacity-detail`, `invoice-capacity-summary`, `tests/e2e/invoice-template-journey` — green with no edit beyond §3; they prove the seeds insert and the invoice reads `udr_resource` unchanged.

### 5. Grep and diff gates
- `git grep -n -E "\b(state|district)\b" -- db/schema/rating db/seeds/sample tests/rating` hits only rate-card columns (`ratecard_ran_usage_lkp`, `SAMPLE_5G_LKP_ROWS`, `SAMPLE_RAN_GEO_LABELS`) and `formatUdrResource` inputs — never a `udr_rated` column or an insert field.
- `git grep -n "bm48" -- db tests workflow-management` returns only `0045`'s header comment and dated history lines.
- `git diff` shows no file under `db/bootstrap/**`, no change to `meta/_journal.json`, no new file under `db/migrations/**`, no billing source file (`services/billing/**`, `db/repositories/billing/**`, `db/schema/billing/**`).

### 6. Release step
First deploy after merge: pipeline run with `buildRatingEngine=true`; database created fresh on that release (`db:setup`). Record the release and the fresh-DB step in `ratemgmt-completed-tracker.md` with the date.

## Dependencies

rm32 (deployed image). Reuses `formatUdrResource` (rm25), `SAMPLE_5G_START_DATE` / `SAMPLE_RAN_GEO_LABELS` (rm18/rm29), the existing rm23 harness and the billing e2e fixtures.

## Verification checklist

- [ ] `db:setup` on an empty database: `information_schema.columns` for `rating.udr_rated` lists `udr_resource` and neither `state` nor `district`, on the parent and on a partition (`rm01` 15b); `tests/rating/rm13-migration-boundary` and `check:rating-migration-boundary` pass on the rewritten `0045`.
- [ ] `meta/_journal.json` is unchanged; no new migration file exists; `db/migrations/README.md` rule 4 carries the dated one-time note.
- [ ] `grants` 10a: `udr_resource` in no role's UPDATE list; `rating_runtime` can INSERT it; `pg_attribute` shows the two columns dropped.
- [ ] `rm23`: re-versioning the card leaves a rated row's `udr_resource` unchanged; UPDATE of `udr_resource` refused for `rating_runtime`, `app_runtime`, `billrun_runtime`.
- [ ] `db:seed-sample` inserts without the removed fields; every non-capacity seeded RAN row except sequence `SAMPLE_NULL_GEO_SEQUENCE` has a non-NULL `udr_resource` equal to `formatUdrResource` of its label; the capacity rows match their card cell; exactly one capacity row (`POLY-APX-UNMAPPED`) is `NULL`.
- [ ] The billing suites in §4 are green with no edit beyond the raw INSERT and two comments; the posted sample invoice renders per-polygon detail unchanged.
- [ ] The grep and diff gates in §5 pass.
- [ ] `tsc --noEmit`, ESLint, Prettier and the DB-free unit suite green; the python-gated suites (`rm07`, `rm09`, `rm13`, `rm23`, `rm27`) green via `rmtest-runner:local`.
- [ ] The first release after merge is deployed with `buildRatingEngine=true` and a fresh database; recorded in the completed tracker. Billing owner told which test lines changed (rule 21).
