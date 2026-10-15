# rm29 — Seeds, write-once proof, E2E and ship gate — Spec

- **Unit:** rm29 of Phase H (`rm00-build-plan.md`)
- **Repo:** both (tests/CI; seeds are app-surface) · **Boundary:** `db/seeds/sample/**`, `tests/rating/**`, `tests/helpers/rating-ran-harness.ts`, `tests/db/billrun-capacity-*.integration.test.ts` (key literals only), the worker image tag.
- **Authorizes from:** `_updatemodule-rating-udr-key-resource-plan.md` R1–R9 and §5, §10; `ratemgmt-architecture.md` Inv 2, 27, 28; `ratemgmt-code-standards.md` §0.1, §10 tests 1–20; `ratemgmt-ai-workflow-rules.md` §0.1 rules 6, 7, 9, 31–34.
- **Depends on:** rm24–rm28.

## Goal

Make the sample data and the end-to-end tests speak the raw-key / `udr_resource` contract, prove `udr_resource` is write-once for every runtime role, and close the update with a green guardrail suite (tests 1–20), so billing slice 2 can read polygon, State, District and start date from `udr_rated` alone.

## Design

- **Seeds bypass rating, so they must write the contract themselves.** `buildSampleUdrRatedRow` (`db/seeds/sample/udr-rated-sample.ts:126`) inserts `udr_rated` rows directly. Its `buildUdrKey` (`:94-109`) lower-cases and trims the polygon cell; it must become a call to `buildRawUdrKey` (rm25), and the spec gains an optional `udrResource` field written through. Rows seeded from a card cell carry `formatUdrResource(...)`; deliberately unmapped rows carry `NULL`.
- **One sample row stays `NULL`.** The capacity appendix profile's card-missing polygon (`POLY-APX-UNMAPPED`, `seed-billrun-sample.ts:155`) keeps `NULL` `udr_resource`, `state` and `district`: it exercises billing's fail-loud path (billing D29) and is the only `NULL` in the sample set.
- **Start dates come from the cards.** The Sample-5G card's polygon start date is `SAMPLE_5G_START_DATE` (`2026-01-01`, `sample-5g-fixture.ts:42,395`); the capacity usage card hard-codes `2020-01-01` (`capacity-usage-card.ts:62`). The seeded `udr_resource` must use the same date as the card row it mirrors.
- **The tests that assumed lower-case keys are updated, not deleted.** `rm23-udr-geo-frozen` finds a row by `r.udrKey.includes(cell.polygonId.toLowerCase())` (`:156`); under raw keys that match fails. It becomes an exact match on the key's last segment (`key.endsWith("|polygon_id=" + cell.polygonId)`), and gains the `udr_resource` assertions.
- **Write-once is proved per role.** The existing rm23 test refuses `UPDATE` of `state`/`district` for `rating_runtime`, `app_runtime`, `billrun_runtime`; the same loop covers `udr_resource`. `grants.integration.test.ts` enumerates `pg_attribute`, so a new column would already be covered; it also asserts `udr_resource` appears in **no** role's column `UPDATE` list.
- **The image tag is bumped once, here.** Units rm26–rm28 test against a locally built image; the release tag (`RATING_ENGINE_VERSION`, stamped as `rating_engine_version`) is bumped as the last step so rows written under the raw-key rule are identifiable. No flow YAML change, so `rating_flow_revision` does not move.
- **Cross-module note, no action:** the billing flow's appendix CTEs (`bill_run_processing.yml`, 4 canonical/casefold matches) reconstruct a lower-cased key and will stop matching card rows. bm49 already stopped reading the appendix and billing slice 2 removes the write, so nothing user-visible degrades; record it in the change description.
- **Out of scope:** `rm08`/`rm10`/`rm11` suites that still use the pre-rm21 profile (not touched; they key on their own opaque keys); any billing code; new columns, migrations or grants.

## Implementation

### 1. Seeds and harness
- `db/seeds/sample/udr-rated-sample.ts`: `buildUdrKey` → `buildRawUdrKey` for the `polygonCell` shape (keep the JSON shape for non-RAN rows, unchanged); update the comments at `:44-50` and `:84-93` (they describe "CANONICAL … lower+trim"); add `udrResource?: string | null` to `SampleChargeSpec` and write `udrResource: spec.udrResource ?? null` in the returned row (the Drizzle column already exists, `udr-rated.ts:62`).
- `db/seeds/sample/seed-billrun-sample.ts`: in `seedSampleCapacityCharges` (`:1476-1596`), pass `udrResource: cell.mapped ? formatUdrResource({ state: cell.state ?? null, district: cell.district ?? null, polygonStartDate: "2020-01-01" }) : null` for the appendix cells (`:1527-1552`); the per-row synthetic anchor polygons (`:1584-1588`) stay unmapped and `NULL`. Update the comments at `:94` and `:1465-1471`.
- `db/seeds/sample/capacity-usage-card.ts`: no change (its start date is the source of truth); add a one-line comment that `udr_resource` mirrors it.
- `tests/helpers/rating-ran-harness.ts`: no logic change (it already writes feed polygons as the card holds them); update the file comment to say keys are raw.

### 2. Tests
- `rm01-schema.integration.test.ts`: the `udr_resource` column is still nullable `text` on the parent and on a partition; replace any "reserved" wording in test names or comments.
- `rm23-udr-geo-frozen.integration.test.ts`: (a) replace the lower-cased polygon match with an exact one; (b) after rating, assert each row's `udr_resource` equals `formatUdrResource` of its cell; (c) after the card re-version (`reversionCard`, `:166-192`) the already-rated row's `udr_resource` is unchanged, while the run-2 re-rate carries the revised labels and **the same** start date unless the re-version changes it; (d) extend the `UPDATE` refusal loop (`:243`) to `["state", "district", "udr_resource"]` for all three roles.
- `grants.integration.test.ts`: assert `udr_resource` is in no role's column-`UPDATE` list (extend the existing enumerated check around `:229`).
- `rm13-e2e-journey.integration.test.ts`: refresh the journey so the rated row's `udr_key` is the raw key and `udr_resource = state|district|date` of its cell; the supersession and completeness steps stay.
- Guardrail tests: this unit completes #19 (full three-role proof) and runs 1–20 together (`ratemgmt-code-standards.md` §10).
- `tests/db/billrun-capacity-appendix.integration.test.ts` and `billrun-capacity-aggregation.integration.test.ts`: update only the key literals (`canonical` cells built by the seed) so they pass against raw seeded keys. Do **not** change their appendix assertions: that test is billing's and is rewritten in billing slice 2 (plan D31).

### 3. Grep and diff gates (run in CI as a script or documented command)
- No `casefold`, `.lower(`, `.toLowerCase()`, `canonical_udr_key` or `_normalise_value` touching a key value in `prp.py`, `rp.py`, `rl.py`, `db/seeds/sample/**`, `tests/helpers/**` (the `service_code` strip and unrelated lower-casing are allowed).
- `git diff` against the unit's base shows no file under `db/migrations/**` or `db/bootstrap/**`, no new `udr_rated` column in `db/schema/rating/udr-rated.ts` (the comment change is rm25's), and no file under `services/billing/**`, `db/repositories/billing/**` or `db/schema/billing/**`.

### 4. Release step
Rebuild and tag the worker image; set `RATING_ENGINE_VERSION` to the new digest in the dev compose and the Container App definition (rm04 mechanism). Record the tag in `ratemgmt-progress-tracker.md` with the date.

## Dependencies

None. Reuses the existing seed helpers, the shared harness and `validation/rating/*` (rm25).

## Verification checklist

- [ ] Guardrail tests 1–20 pass against a live database with `python3` and the worker runtime; the `rm13` journey's rated row has the raw key and the expected `udr_resource`.
- [ ] The sample seeds write raw keys; every mapped appendix row has `udr_resource` equal to its card cell's `state|district|date`; exactly one sample row (`POLY-APX-UNMAPPED`) has `NULL`.
- [ ] `UPDATE … udr_resource` is refused with `permission denied` for `rating_runtime`, `app_runtime` and `billrun_runtime`; the grants test shows it in no role's UPDATE list.
- [ ] After a card re-version, an already-rated row's `udr_resource` is unchanged.
- [ ] The grep gates in §3 find nothing; the diff gates show no migration, no bootstrap change, no billing file.
- [ ] The billing capacity suites pass with updated key literals and unchanged appendix assertions; the dead-appendix note is in the change description for the billing owner.
- [ ] The worker image is tagged once and `rating_engine_version` on new rows reflects it.
- [ ] `tsc --noEmit`, ESLint, Prettier and the DB-free unit suite are green; OWASP/SAST gates unaffected.
- [ ] Plan open items closed or updated: OI-R3 (traced in rm28), OI-R4 (no other consumer of `udr_resource`, confirmed by a search of `services/**` and `db/repositories/**` outside billing's usage query).
