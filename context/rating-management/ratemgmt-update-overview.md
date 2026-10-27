# Rating Management — Update Overview: Drop `udr_rated.state` / `.district` (Phase J)

**Reference:** `_change-rating-drop-udr-rated-geo-columns-plan.md` (D1–D9; eng-reviewed 2026-10-27). Build units: `specs/rm00-build-plan.md` Phase J (rm31–rm33).
**Scope of this update:** the RAN-usage rating runtime — PRP (`prp.py`), RP (`rp.py`), RL (`rl.py`) of the `rating-engine-ran-usage` flow — the `udr_rated` schema (`0045` rewritten in place, Drizzle), sample seeds, rating tests and the rule reversals in the plan §7. No grant change, no new migration, no change to `udr_resource`, no billing code.
**Operated by:** BSS IT Operations.
**Rollout:** fresh database, **this round only** (owner, 2026-10-27): no production exists, every environment is set up from scratch on the release that carries rm32's worker image. Any later column removal is a forward migration.
**Earlier updates:** until rm31 this file described the raw `udr_key` / `udr_resource` update (Phase H). That content now lives in `ratemgmt-project-overview.md`, in the sections marked "Phase H": its goals 1–10 are the overview's goals 20–25, its core user flow is "Raw-key / `udr_resource` flow (Phase H)", its features are "Raw `udr_key` and `udr_resource` cell label (Phase H)", and its success criteria 1–12 are the overview's 32–36. The PER_UNIT update (Phase G) is in the sections marked "Phase G". Delivered specs that cite this file for Phase H content (rm24–rm29) mean those sections.

## Overview

The Rating Management module reads raw RAN usage files, resolves each record to its subscriber, prices it, and loads immutable rows into `rating.udr_rated` for the bill run. Since bm48 every rated `RAN_USAGE` row has carried the matched rate-card cell's `state` and `district` **twice**: as two standalone columns (migration `0045`) and as the first two segments of `udr_resource = state|district|polygon_start_date` (Phase H, Inv 28). The invoice reads only `udr_resource` (since bm71), so the standalone pair has no consumer and contradicts the Phase H design intent of adding no geo column to `udr_rated`. This update removes the pair. PRP keeps reading the labels from the card — they are the inputs to `udr_resource` and to the `|`-in-label check — but no longer stamps them on the row; RP stops carrying them; RL stops COPYing them; the columns leave the schema. `udr_resource` and its contract are untouched.

## Goals

1. Remove `udr_rated.state` and `udr_rated.district` from the schema, the Drizzle model, the seeds and the tests.
2. Stop PRP stamping, RP carrying and RL COPYing the two columns; `udr_resource` becomes the only geo carrier.
3. Change nothing about `udr_resource`: shape `state|district|polygon_start_date`, ISO date, empty segment for a blank label, `|`-in-label refusal (`RATECARD_LABEL_INVALID`), write-once, required for `RAN_USAGE`, `NULL` otherwise.
4. Keep PRP's card read and `RatecardCell.state`/`.district` as the inputs to `udr_resource` and the label check.
5. Rewrite `0045` in place to `DROP COLUMN IF EXISTS state, district` for this round only (fresh-DB setup; no production); keep the migration-immutability rule for every later change.
6. Reverse the rules that say the columns stay (workflow rules §0.1 rules 10 and 17, code-standards §0.1 data rules 1 and 3, Inv 26, update-overview goal 6) with dated notes, originals kept; record the rm32 §4.3 waiver by name.
7. Keep the paper trail short: only statements that would read as a regression or assert the columns exist are annotated.

## Core user flow (start to finish)

Worked example as in Phase H: rate-card row `polygon_id = ABCD_25 DISTRICT2`, `state = STATE-1`, `district = DISTRICT-1`, `polygon_start_date = 2026-01-01`.

1. **Provision the rate card.** Unchanged; a `|` in `state` or `district` still stops the batch when PRP loads the card.
2. **File arrives; PRP claims and parses.** Unchanged; `udr_key` is built from raw values.
3. **PRP matches the record to its card cell.** Unchanged exact lookup. The cell carries `state`, `district`, `polygon_start_date` and the precomputed `udr_resource = STATE-1|DISTRICT-1|2026-01-01`.
4. **PRP stamps the record with `udr_resource` only.** `ParsedRow` and the chunk Parquet no longer have `state`/`district` columns.
5. **RP passes `udr_resource` through** (`_GEO_COLUMNS = ("udr_resource",)`) and prices the record `PER_UNIT`.
6. **RL loads the batch.** `COPY_COLUMNS` ends with `udr_resource`; a `RAN_USAGE` chunk without it still raises; non-RAN writes `NULL`. The table has no `state`/`district` columns.
7. **Billing builds the invoice** from `udr_key` and `udr_resource`, as in Phase H. Nothing changes for billing.
8. **Release.** The worker image and the database are set up together: deploy with `buildRatingEngine=true`, create the database fresh on that release. A fresh database never has the columns; an older worker image would COPY into them and fail at `COPY`, which is why the two travel together.

## Features (by category)

**PRP (`prp.py`)**
- `ParsedRow` loses `state`/`district`; enrichment stamps `udr_resource` only; `_chunk_frame` emits no geo columns.
- Unchanged: `_RATECARD_SQL` (still selects `l.state, l.district`), `RatecardCell`, `_geo_label`, `build_udr_resource`, `invalid_label_cells`, the `RATECARD_LABEL_INVALID` refusal.

**RP (`rp.py`)**
- `_GEO_COLUMNS = ("udr_resource",)`; the generic pass-through loop is untouched.

**RL (`rl.py`)**
- `state`/`district` removed from `COPY_COLUMNS`; `_GEO_OPTIONAL_COLUMNS` and `_geo_value` deleted. `_resource_value`, the collision guard and the supersede logic unchanged. No "tolerate the columns" code: `build_chunk_rows` reads Parquet columns by name, and with PRP in the same unit no chunk carries them.

**Schema and migration**
- `0045_rating_udr_rated_geo.sql` rewritten in place to `ALTER TABLE "rating"."udr_rated" DROP COLUMN IF EXISTS "state", DROP COLUMN IF EXISTS "district";` — journal entry kept at idx 45, no new migration number. A no-op on a fresh database; skipped on any database that already applied the original (`db/migrations/README.md` rule 4), which is why this round is fresh-DB only.
- `db/schema/rating/udr-rated.ts` loses the two fields. No grant change.

**Seeds and tests**
- `udr-rated-sample.ts` row spec and insert lose `state`/`district`; `seed-billrun-sample.ts` `sampleRanGeo` emits `udrResource` built with `formatUdrResource` (the `SAMPLE_NULL_GEO_SEQUENCE` and `POLY-APX-UNMAPPED` rows stay `NULL`); the capacity path keeps `udrResource` only.
- `tests/e2e/invoice-template-journey.integration.test.ts` raw INSERT loses the two columns.
- `rm09` (`COPY_TAIL` → `["udr_resource"]`, geo cases deleted), `rm07` (bm48 cases assert `udr_resource` only), `rm08`, `rm13-e2e`, `rm27` retargeted; `rm01` 15b asserts the columns are absent on parent and partition; `grants` 10a covers `udr_resource` only; `rm23-udr-geo-frozen` keeps its name and is re-scoped to `udr_resource`.
- Three stale comment lines reworded (`invoice-template-journey:452`, `udr-rated-sample.ts:57-59`, `rl.py:152-159`) plus the flow-YAML comment at `rating-engine-ran-usage.yaml:135`.

**Documentation**
- rm31 (delivered 2026-10-27): dated reversal notes in `ratemgmt-ai-workflow-rules.md` (rules 10, 17; the rm32 waiver under §4), `ratemgmt-code-standards.md` (§0.1 data rules 1–3), `ratemgmt-architecture.md` (Inv 26), `ratemgmt-project-overview.md`, `rm00-build-plan.md` (rm23 entry, Phase J), and banners on rm26–rm29. Billing-side notes and the `db/migrations/README.md` rule-4 note belong to rm33 (billing owner told, rule 21).

## In scope (what we are building)

- rm31 — the reversal notes above (docs only).
- rm32 — PRP, RP and RL changes in one unit under the recorded §4.3 waiver (ordered commits RL → RP → PRP → tests), with `rm07`, `rm08`, `rm09`, `rm13`, `rm27` retargeted.
- rm33 — the `0045` rewrite, Drizzle, seeds, the e2e raw INSERT, `rm01`/`grants`/`rm23`, the comment lines, the README rule-4 one-time note; first release with `buildRatingEngine=true` and a fresh database.

## Out of scope (what we are not building)

- Any change to `udr_resource` — its shape, delimiter, date format, write-once guard or the `RATECARD_LABEL_INVALID` check.
- Any change to `udr_key`, the rate card's own `state`/`district` columns, grants, or billing code.
- A forward `DROP` migration for this round (no populated database exists); a backfill; a cutover guard.
- A hash-drift check for applied migrations (APP-03 fix) and a pipeline coupling of `buildRatingEngine` to rating migrations — considered in review, declined.
- A "stays gone" guardrail test; the specific comment lines are fixed instead.
- A `rating_engine_version` bump (row semantics are unchanged; optional operator hygiene).

## Success criteria (what "done" looks like)

1. `db:setup` on an empty database yields `rating.udr_rated` with `udr_resource` and **no** `state`/`district` column, on the parent and on every partition (`rm01` 15b).
2. A rated `RAN_USAGE` chunk and the COPY carry `udr_resource` and no geo columns; a `RAN_USAGE` chunk without `udr_resource` still raises; a non-RAN chunk writes `NULL` (`rm09`, `rm27`).
3. The matched cell's row still has `udr_resource = STATE-1|DISTRICT-1|2026-01-01`; a blank district still gives `STATE-1||2026-01-01`; a `|` in a card label still refuses the batch (`rm07`).
4. Re-versioning the card after rating leaves `udr_resource` unchanged; an UPDATE of it is refused for `rating_runtime`, `app_runtime` and `billrun_runtime` (`rm23`, `grants` 10a).
5. The `rm13` journey passes with the raw key and the expected `udr_resource`.
6. Sample seeds insert without the removed fields, every seeded non-capacity RAN row carries a non-NULL `udr_resource` except the deliberate `NULL` fixtures, and the posted invoice renders per-polygon detail from `udr_resource` unchanged (billing e2e, `invoice-capacity-detail`).
7. No rating context document asserts the columns stay without a dated note pointing to the plan; no rating code comment still says the columns are written.
8. The first release after rm33 is deployed with `buildRatingEngine=true` and a database created fresh on that release.
