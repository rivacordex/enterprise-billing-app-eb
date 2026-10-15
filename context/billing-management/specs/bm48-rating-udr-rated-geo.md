# bm48 — Rating persists `state`/`district` on `udr_rated` _(cross-module)_

**Unit:** bm48 (Invoice Template update, Part 4) · **Status:** Delivered 2026-10-08 (code), commit `b4d28e4`; DB/python suites not separately re-run (see residuals) · **Boundary:** rating module only, under `ratemgmt-ai-workflow-rules.md` (one PR with ordered commits, under a bm48-only waiver of its §4.1/§4.3; owner, 2026-10-08). No billing code changed.
_Compacted 2026-10-15. Full pre-compaction text: `git show a63eebb:context/billing-management/specs/bm48-rating-udr-rated-geo.md` in this repo; the codebase copy keeps the full text._

## Goal

When RAN-usage rating matches a record to its ratecard cell, write that cell's `state` and `district` onto `rating.udr_rated` at insert. Every newly rated `RAN_USAGE` row then carries frozen geo, and the invoice (bm49) groups by it with no render-time ratecard lookup. Rows rated earlier stay `NULL`.

## As built

**Specs from:** merged plan §15 R9; architecture _Invoice Template deltas_; Inv #36 (amended here), #47; code-standards Part 2 data rule 6.

**Gates:**
- G1 / X1 / C1 = **R9** (decided 2026-10-07).
- G13: the `udr_key` → cell mapping reuses PRP's existing match (`canonical_udr_key`, `prp.py:576-588`). Decided 2026-10-08 and recorded in `ratemgmt-architecture.md` Inv #26.

**Premise corrections (verified 2026-10-07):**
- Rating does **not** read `rate_per_unit` from the card. The rate comes from `product_offering_price.price_component #>> '{params,ratePerUnit}'` in RP.
- The card is read in **PRP** `extract_ratecard` for `lkp_subscriber_ref_id`/`service_code`, keyed by canonical cell with a duplicate-cell fail-closed. That is the capture point.
- RL inserts by COPY (`COPY_COLUMNS`), and `build_chunk_rows` raises `KeyError` for a missing column.

**D1 — Two nullable, frozen columns** (migration `0045_rating_udr_rated_geo.sql`, a forward migration on the partitioned parent, metadata-only):
```sql
ALTER TABLE "rating"."udr_rated" ADD COLUMN IF NOT EXISTS "state" text;
ALTER TABLE "rating"."udr_rated" ADD COLUMN IF NOT EXISTS "district" text;
```
- Both columns carry comments: "Ratecard state/district label of the matched RAN cell, frozen at rating (bm48)".
- No grant change. `rating_runtime`'s table-level `INSERT` covers the columns, and no role holds `UPDATE` on them (`rating_runtime` has `UPDATE ("status")`; `app_runtime`/`billrun_runtime` have the six claim columns). So they are write-once.
- No CHECK and no index; bm49 uses the partial `udr_rated_billrun_idx`.
- `NULL` means "rated before bm48" or "the card label was blank".

**D2 — Capture in PRP, carry through RP, insert in RL:**
- **PRP:** `extract_ratecard` also selects `l.state, l.district`, and `RatecardCell` becomes `{lkp_subscriber_ref_id, service_code, state, district}`. The record enrichment attaches them; a card miss is still `LOOKUP_MISS` and never rated.
- **RP:** passes the columns through the Parquet unchanged.
- **RL:** `"state", "district"` are appended at the end of `COPY_COLUMNS`.
- **As built:** labels are written as stored on the card, except that a blank or whitespace-only label is written as `NULL` (`prp.py` `_geo_label`).

**D3 — Card version:** PRP reads the **ACTIVE** version of the card named by `productCardLookUp`, so geo is frozen at rating time. This closes bm45's D4 residual for rows rated after bm48.

**D4 — Other usage types:** RL fills `None` for these two columns only, through a named allowlist. The `KeyError` guard still protects every other column.

**D5 — Forward-only:** no backfill.

**D6 — Inv #36 amended in the same change set:** state/district come from the ratecard "as matched at rating time and persisted onto `rating.udr_rated.state/district` (bm48, R9)". X1, C1 and the overview's _Overlap_ item were closed together. The bm45 flow snapshot kept being written.

## Files

- `db/migrations/0045_rating_udr_rated_geo.sql` + `meta/_journal.json` entry
- `db/schema/rating/udr-rated.ts`: `state: text("state")`, `district: text("district")`
- `workflow-management/worker/workflow-engine/runtime/{prp,rp,rl}.py`
- `db/seeds/sample/udr-rated-sample.ts`: RAN rows carry card geo, with one row left `NULL` for the "Unassigned region" path
- `billmgmt-architecture.md` (Inv #36), `ratemgmt` architecture and progress tracker, `billmgmt-known-issues.md`

## Tests and evidence

- `tests/rating/rm01-schema.integration.test.ts`: the nullable `text` columns exist on the parent and on a partition.
- `tests/rating/grants.integration.test.ts` (10a): no role has `UPDATE` on the columns; `rating_runtime` can INSERT.
- `rm07-prp.*`: PRP output carries geo; blank labels become `NULL`; a duplicate cell still fails closed.
- `rm09-rl.*`: RL writes both columns; a missing column raises for RAN; non-RAN rows get `NULL`.
- `rm13-e2e-journey.integration.test.ts`: the end-to-end row carries the card's geo.
- `rm23-udr-geo-frozen.integration.test.ts`: re-versioning the card leaves rated geo unchanged, and an `UPDATE` is refused for all three roles.
- Evidence:
  - the `rating-migration-boundary` check passes (`db/checks/check-rating-migration-boundary.ts`);
  - `canonical_udr_key` is untouched;
  - `b4d28e4` touches only the migration, the rating schema, seeds, rating tests and PRP/RP/RL.

## Later changes and residuals

- **2026-10-12, unrun or unconfirmed per the tracker:**
  - The existing-rows case of `0045`. Fresh DBs applied it in the bm63 integration run, 1219/0.
  - The python-gated suites `rm07`, `rm13` and `rm23`.
  - `grants` as a named result; it is DB-only and falls within the bm63 run.
- **Not done (2026-10-12):**
  - The flow and `rating_engine_version` bump. `b4d28e4` touches no flow YAML; this is presumably deferred to the deploy-time worker image rebuild, but unconfirmed.
  - `bm00` Unit 48 "Builds" text (~l.314) still says rating reads `rate_per_unit` from the card.
- **Superseded 2026-10-14 (rating raw-key update, rm24–rm29; billing plan D8, D31):**
  - Rating stores `udr_key` raw.
  - The invoice reads the polygon from the `polygon_id=` segment of `udr_key`, and State, District and the start date from `udr_resource`.
  - The flow's appendix is no longer read (bm49) and is removed in billing slice 2.
  - bm48's `state`/`district` columns are unchanged: still captured by PRP and written once by RL.
- **Invoice Template Phase 3 (planned):** the invoice stops reading `udr_rated.state/district` (Inv #56). The columns stay (D32).
