# Rating Management — Update Overview: Raw `udr_key` and `udr_resource` Cell Label

**Reference:** `_updatemodule-rating-udr-key-resource-plan.md` (companion: `_updatemodule-billing-invoice-template-phase3-billrun-plan.md`)
**Scope of this update:** the RAN-usage rating runtime — PRP (`prp.py`), RP (`rp.py`), RL (`rl.py`) of the `rating-engine-ran-usage` flow — plus sample seeds, rating tests and the rule/document amendments listed in the plan §7. No schema change, no migration, no grant change, no billing code.
**Operated by:** BSS IT Operations.
**Rollout:** fresh database this round (decided 2026-10-14): no rows exist that predate this change.

## Overview

The Rating Management module reads raw RAN (Radio Access Network) usage files for mobile network operators from a landing directory, resolves each record to its subscriber, prices it against the subscriber's product, and loads immutable rows into `rating.udr_rated` for the bill run. This update changes what rating writes for each `RAN_USAGE` record so the invoice can print each polygon's original ID, its start date and its State-District label without adding a column to `rating.udr_rated` and without the invoice ever reading the rate card: `udr_key` keeps the polygon, MNO and commercial-unit values exactly as the feed sends them (the case-folding and trimming rule is removed), PRP matches each record to its rate-card cell by exact comparison, and PRP builds the label `state|district|polygon_start_date` once per matched card cell so RL writes it, at INSERT, into the existing `udr_resource` column. Billing then reads the polygon from the `polygon_id=` segment of `udr_key`, and State, District and the start date from the three segments of `udr_resource`.

## Goals

1. Store the polygon ID in `udr_key` exactly as the feed sends it, so the invoice prints the original case and spacing (for example `ABCD_25 DISTRICT2`, not `abcd_25 district2`).
2. Remove the value normalisation (`strip().casefold()`) from `udr_key`; keep the key shape — key names in sorted order, `name=value`, joined by `|`.
3. Match each feed record to its rate-card cell by exact, case-sensitive and whitespace-sensitive comparison; a record with no exact match stays a whole-batch `INPUT_UNMAPPED` hard stop.
4. Write `udr_resource = state|district|polygon_start_date` (ISO date `YYYY-MM-DD`) for every `RAN_USAGE` row, once, at INSERT, from the matched rate-card cell.
5. Add no column to `rating.udr_rated`, no migration file and no grant change; `udr_resource` already exists as nullable `text`.
6. Leave the bm48 `state` and `district` columns exactly as they are.
7. Fail the batch before rating if a rate-card `state` or `district` label contains `|`, so the label can always be split into three segments.
8. Record the reversal of the protected rules (the "fixed" canonical key rule; "`udr_resource` is reserved, do not populate") in every rating document that states them.
9. Keep rating independent of billing code: billing slice 1 ships without this change; billing slice 2 (usage query and layout v2 detail) depends on it.
10. State the accepted trade-off — records that differ only in case or whitespace become different keys — and cover it with a test.

## Core user flow (start to finish)

Worked example. Rate-card row: `mno_public_key = MNO-001`, `commercial_unit_public_key = CU-5G`, `polygon_id = ABCD_25 DISTRICT2`, `state = SELANGOR`, `district = PETALING`, `polygon_start_date = 2026-01-01`.

1. **Provision the rate card.** An operator uploads and activates a `ratecard_version`. If any row's `state` or `district` contains `|`, PRP stops the batch when it loads the card (goal 7).
2. **File arrives.** `rating-input-file-202608151200.udr` lands in `/data/landing`. It has no header and 7 columns: `mno_public_id, commercial_unit, polygon_id, datetime_YYYYMMDDHHMI, usage_volume, district_name, service_code`. One row is `MNO-001,CU-5G,ABCD_25 DISTRICT2,202608151200,350.000000,PETALING,SVC-01`. The `district_name` column in the feed is not used.
3. **PRP claims the batch** (`UNIQUE (file_key, batch_run_num)`, unchanged) and parses each row. It builds `udr_key` from the raw field values: `commercial_unit=CU-5G|mno_public_id=MNO-001|polygon_id=ABCD_25 DISTRICT2`. A blank key field is still `MISSING_KEY_FIELD`.
4. **PRP matches the record to its rate-card cell.** It loads the ACTIVE version of the card named by the offering's `productCardLookUp` once per batch and indexes it in memory by the same raw serialisation. For each record it does one dictionary lookup. If the feed had sent `abcd_25 district2`, there would be no match: `INPUT_UNMAPPED`, and the whole batch is refused.
5. **PRP stamps the record** with the matched cell's `state`, `district` and `udr_resource = SELANGOR|PETALING|2026-01-01`. The label was built once for that card cell when the card was loaded, not once per record. A blank state or district becomes an empty segment, for example `|PETALING|2026-01-01`. PRP writes these columns to the chunk Parquet.
6. **RP passes the value through** unchanged, as it does for `state` and `district`, and prices the record `PER_UNIT` (unchanged).
7. **RL loads the batch.** It copies the rows into `rating.udr_rated` at status `RATED` in one transaction, including `udr_resource`. The live-row constraint `UNIQUE (partition_period, udr_key, is_live)` and the billed/in-flight collision guard compare the raw keys. RL then archives the file.
8. **Billing builds the invoice.** For this row it prints the polygon name `ABCD_25 DISTRICT2` from the `polygon_id=` segment, the group label `SELANGOR - PETALING` and the start date `01/01/2026` from `udr_resource`. It never reads the rate card.
9. **Operator recovery.** If a batch hard-stops, the operator fixes the feed or the rate card and re-drops the same filename. The same `file_key` gets the next `batch_run_num` and supersedes the prior attempt (unchanged).

## Features (by category)

**Key construction (PRP)**
- `build_udr_key(profile, row)` replaces `canonical_udr_key`: key names sorted once per profile, each value taken exactly as parsed from the feed, joined as `name=value` with `|`.
- The value-trimming and case-folding function `_normalise_value` is removed.
- The `MISSING_KEY_FIELD` check still treats a blank or whitespace-only value as missing.
- The 512-character cap on `udr_key` is unchanged.

**Rate-card matching (PRP)**
- The in-memory card index is keyed by the same raw serialisation of the card's `mno_public_key`, `commercial_unit_public_key` and `polygon_id`.
- Two card rows that differ only by case or whitespace are now different cells, and the DB constraint `ratecard_ran_usage_lkp_row_key_unique` already rejects exact duplicates. The fail-closed guard in `extract_ratecard` stays, reworded, and now fires only on a serialisation collision.
- A feed record with no exact card match is `INPUT_UNMAPPED`; a card cell with no matching feed record is `RATECARD_COVERAGE_GAP` (default `HARD_STOP`, configurable to `WARN`) — both unchanged.

**Cell label (PRP → RP → RL)**
- `_RATECARD_SQL` also selects `l.polygon_start_date`.
- `RatecardCell` gains `polygon_start_date` and a precomputed `udr_resource` string.
- `ParsedRow` and the chunk frame carry a nullable string column `udr_resource`.
- RP passes it through; RL appends `"udr_resource"` to `COPY_COLUMNS` after `"district"`.
- RL's named optional allowlist includes `udr_resource`: a usage type that reads no rate card writes NULL, but a `RAN_USAGE` chunk missing it raises, which proves PRP stamped it and RP carried it.

**Loading and guards (RL)**
- No code change to the live-row constraint, the billed/in-flight collision guard (`rl.py:325-362`) or supersession by `file_key`; they now compare raw keys.
- Two `RATED` rows whose keys differ only in case both load; this is the accepted behaviour and has a test.

**Data model and access**
- No new `rating.udr_rated` column and no migration. `udr_resource` stays nullable `text`.
- `rating_runtime`'s table-level INSERT covers writing `udr_resource`; no role holds UPDATE on it, so it is written once.
- `rating_flow_revision` / `rating_engine_version` are bumped so rows written under the raw-key rule are distinguishable.

**Seeds and tests**
- Sample seeds (`udr-rated-sample.ts`, `seed-billrun-sample.ts`, `capacity-usage-card.ts`) and the test harness emit raw cell keys and a populated `udr_resource`; one sample RAN row keeps `NULL` `udr_resource` to exercise billing's fail-loud path.
- Rating tests are extended in `rm01`, `rm07`, `rm09`, `rm13`, `rm23` and `grants`, as listed in the plan §5.

**Documentation amendments**
- The plan §7 lists every rule to amend in the same change set: `_newmodule-rating-engine-plan.md` §4.2, rm07 D2 and rm01 D10, `ratemgmt-architecture.md` Inv #19 and the Inv #20(b)/#26 wording, `ratemgmt-ai-workflow-rules.md` lines 110 and 118, `ratemgmt-code-standards.md` §6, `ratemgmt-project-overview.md`, the rm07 and rm21 specs, `rm00-build-plan.md`, plus the billing-side bm45, bm48, Inv #36/#47 and known-issues entries.

## In scope (what we are building)

- `build_udr_key` in `prp.py` and the removal of `_normalise_value` and the normalising body of `canonical_udr_key`, with every docstring and comment that describes canonical behaviour updated.
- The exact-match rate-card index in `extract_ratecard`, and a reworded fail-closed guard for serialisation collisions (the case/whitespace rationale is removed).
- `polygon_start_date` in the rate-card query, and `RatecardCell.udr_resource` built once per card cell.
- The fail-closed check for a `|` in a card `state` or `district` label.
- `udr_resource` carried through `ParsedRow`, the chunk Parquet, RP and RL `COPY_COLUMNS`, with RAN required and other usage types NULL.
- The version bump so raw-key rows are identifiable.
- Seeds, test harness and the rating tests listed in the plan §5, including the test that documents the case-variant behaviour.
- Amendment of the rules and documents listed in the plan §7.

## Out of scope (what we are not building)

- Any new column on `rating.udr_rated`, any migration, any grant change.
- Reversing bm48: the `state` and `district` columns stay, and their consumers are untouched.
- Rewriting or backfilling existing `udr_rated` rows; none exist on the fresh database.
- A cutover guard or a normalised uniqueness backstop (for example a `lower(trim(udr_key))` index); the owner accepted raw keys without them.
- Changing the 512-character `udr_key` cap, the `UNIQUE (partition_period, udr_key, is_live)` constraint, or supersession by `file_key`.
- Changing the rate-card schema, the upload screen, or the feed format.
- Normalising or correcting values at the feed; the feed is expected to be consistent.
- `udr_resource` for non-RAN usage types; they write `NULL`.
- New rate types, discounts, or any change to PER_UNIT pricing.
- Billing code, the invoice layout and the usage query; they are in the companion billing plan.

## Success criteria (what "done" looks like)

1. A `RAN_USAGE` row for polygon `ABCD_25 DISTRICT2` loads with a `udr_key` containing exactly `polygon_id=ABCD_25 DISTRICT2`, with case and the space preserved.
2. Two records that differ only in the case of the polygon produce two different keys and both load; the test that asserts this passes.
3. A feed record whose polygon differs from the rate card only by case or a trailing space is refused as `INPUT_UNMAPPED`, and the whole batch is refused under `HARD_STOP`.
4. For the matched cell above, the loaded row has `udr_resource = SELANGOR|PETALING|2026-01-01`; a card row with a blank district gives `SELANGOR||2026-01-01`; the date is always `YYYY-MM-DD`.
5. A rate card with `|` in a `state` or `district` label fails the batch before any record is rated.
6. `rating.udr_rated` has no new column and no migration file was added; `udr_resource` appears in no role's column UPDATE privilege, and an UPDATE of it by `rating_runtime`, `app_runtime` and `billrun_runtime` is refused with a permission error.
7. After rating, activating a new rate-card version with different labels or a different start date leaves the already-rated row's `udr_resource` unchanged.
8. A `RAN_USAGE` chunk missing `udr_resource` makes RL raise; a non-RAN chunk writes `NULL`.
9. A batch whose raw keys collide with a live `BILL_APPROVED` row is still refused whole with `LOAD_BLOCKED_BILLED`.
10. The end-to-end journey in `rm13` passes and its rated row has the raw key and the expected `udr_resource`.
11. The `rm07`, `rm09`, `rm13`, `rm23`, `rm01` and `grants` suites pass with the extended cases.
12. No rating document still describes `udr_key` as canonical or `udr_resource` as reserved (plan §7), and billing's slice 2 reads polygon, State-District and start date from `udr_rated` alone, with no rate-card query.
