# rpt04 — Polygon Capacity Lookup (Part B), Deployed Disabled

**Unit:** rpt04. **Boundary:** RUNTIME (`runtime/reporting/polygon_capacity/`, `runtime/reporting/common/delivery.py`), FLOWS (`report-polygon-capacity-lookup`, contract `polygon_capacity.yaml`), ROLE (one grant: `product.product_offering_price`), INFRA (the `polygon-capacity` outbound share and its mount), TESTS.

**Specs from:** `_newmodule-reporting-plan.md` Part B (PC1–PC25, §B.1–§B.3, P-T1–P-T14), P1, P2, P5 current handling, RF8; `rptmgmt-architecture.md` Inv 5, 7, 10, 11; `rptmgmt-code-standards.md` §5.4, §9.8; rpt01 D7 (outbound account), rpt02 (subflows, writer, contracts, codes).

**Depends on:** rpt02.

---

## Goal

`report-polygon-capacity-lookup` writes, for one report date, `Polygon_capacity_lookup_<report_date>.csv`: one positional row per polygon an MNO subscribes to on the RAN usage rate card in force that day, with its buffer-usage resource identifier, service code and subscribed capacity. The file is delivered to the `polygon-capacity` outbound share (write-then-rename, never overwrite) and kept as a Kestra output.

The capacity source is still open (P1), so the flow is **deployed disabled** (PC25) and runs in tests with a fixture capacity source. rpt06 plugs in the real source and enables it.

---

## Design

### D1 — One outbound share per destination (Q1, 2026-10-29; amends rpt01 D7)

- On Azure Files, read access can't be scoped to a folder: SMB needs the account key or identity-based SMB, and a SAS covers a whole share. So **each destination is its own share** on the reporting outbound account, and each reader is given a **read-only SAS on its share only** (HTTPS: REST or `azcopy`).
- rpt04 adds the share **`polygon-capacity`**, its environment storage definition, and its mount at **`/data/outbound/polygon-capacity/`** (= the flow's `outbound_dir`, PC12). Audience: **Mediation and the CSP**, recorded in the `flows/reporting/README.md` _Outbound destinations_ table and the bicep module.
- rpt01's single `outbound` share becomes the `platform-check` share, mounted at `/data/outbound/_platform-check/`. Later destinations (`mno-outstanding`, `invoice-csv`, `gl-feed`) add their own share and mount in the unit that first delivers there.
- **Issuing, storing and rotating the SAS, and confirming Mediation and the CSP can read over HTTPS, is open item RF-OI2.** It doesn't block this unit: the flow is disabled until P1, and nobody reads the share until RF-OI2 is settled.
- Local dev: `./workflow-management/dev/outbound/polygon-capacity` bind-mounted at the same path.

### D2 — Which card: the one the RAN usage product names (Q2, 2026-10-29; amends PC1)

- The card is **not** a flow variable. It's resolved the way rating resolves it (`runtime/rp.py`): `product.product_offering_price.price_component #>> '{params,rateCardLookUp}'` on `usage_rate` prices.
- **For a report date D:** take each offering's `usage_rate` price effective at the end of D (Asia/Kuala_Lumpur), i.e. the latest `start_date_time` ≤ D 23:59:59, and collect the distinct non-null `rateCardLookUp` values.
  - Exactly one name: that's the card.
  - None: FAILED `NO_RATECARD_NAMED <D>`.
  - More than one: FAILED `MULTIPLE_RATECARDS_NAMED <D> <names>`. PQ4.3 fixed one card per file; a second card is a design change, not a run-time choice.
- The resolved name is a label, `ratecard_card_name`, beside `ratecard_version_id`.
- **Grant:** `SELECT` on `product.product_offering_price` (previously planned for rpt09, GL25; it lands here, where it's first read).

### D3 — Version and rows for the date (PC2, PC3, PC17)

- **Version in force at the end of D:** the version of that card with `status` in (`ACTIVE`, `SUPERSEDED`), `activated_at` ≤ D 23:59:59 Asia/Kuala_Lumpur, and whose successor (`superseded_by_version_id`) is either null or was activated after that moment. `DRAFT` and `REJECTED` are never used. No such version: FAILED `NO_ACTIVE_RATECARD_VERSION <D>`.
- **Rows:** that version's `ratecard_ran_usage_lkp` rows with `polygon_start_date` ≤ D and (`polygon_end_date` is null or ≥ D).
- A past D therefore reproduces that day's file (Inv 7).

### D4 — Columns and rounding (PC4–PC9, §B.1)

- Eight columns, no header, in §B.1's order: `mno_public_key`, `commercial_unit_public_key`, `polygon_public_key` (= `polygon_id`), `report_date`, `polygon_start_date`, `resource_identifier_buffer_usage` (= `<mno_public_key>_<district>`, one underscore), `service_code_buffer_usage` (= `service_code`), `polygon_coverage_capacity_mbps`.
- Capacity is rounded half-up to a whole number with `fmt_integer` (rpt02): 1000.49 → `1000`, 1000.50 → `1001`.
- Sorted by `mno_public_key`, `commercial_unit_public_key`, `polygon_id` (PC10).

### D5 — The capacity source interface (PC8, PC25)

- `polygon_capacity/capacity_source.py` defines `CapacitySource` with one method, `capacity_for(rows, report_date) → {(mno, cu, polygon): Decimal | None}`, called once per run with all eligible rows (never per row, Inv rating #10).
- rpt04 ships **`FixtureCapacitySource`** only, reading a fixture file given by an argument; the flow passes a variable `capacity_source: fixture`. Any other value fails `CAPACITY_SOURCE_UNAVAILABLE <name>`.
- A row whose capacity comes back `None` is skipped with `SKIPPED <mno>|<cu>|<polygon> CAPACITY_MISSING` (the PC19 pattern), so rpt06's real source has a defined behaviour for gaps.
- The flow stays `disabled: true`. Enabling it is rpt06's one-line change.

### D6 — Skips and failures (PC16–PC20)

- `report_date`: `report-validate-date` with rule `before_today`, default `yesterday` → `INVALID_REPORT_DATE`.
- Blank `district` → `SKIPPED … DISTRICT_MISSING`; blank `service_code` → `SKIPPED … SERVICE_CODE_MISSING`; missing capacity → `CAPACITY_MISSING`. Label `skipped_polygons`, status WARNING; all skipped → FAILED `ALL_POLYGONS_EXCEPTED`.
- No eligible rows → FAILED `NO_ELIGIBLE_POLYGONS <D>` (an empty headerless file can't be told from a broken one).

### D7 — `common/delivery.py`: safe write, never overwrite (PC13, PC14)

Built here because rpt04 is the first report that delivers to a folder; rpt05, rpt08 and rpt09 reuse it unchanged.

- `deliver(src, outbound_dir, name)`:
  1. if `outbound_dir/name` exists → FAILED `FILE_ALREADY_EXISTS <name>` and nothing is touched;
  2. copy to `outbound_dir/.<name>.tmp`, flush and `fsync`;
  3. rename to `outbound_dir/<name>` with an atomic no-replace rename (`os.link` then unlink of the temp, so a file that appeared in between is never replaced);
  4. on any error, remove the temp and fail.
- It runs only after `report-validate-output` has passed (Inv 5), and before `publish`, so a FAILED delivery publishes nothing.
- rpt01's platform check moves onto `deliver()` so there's one implementation.

### D8 — Flow `report-polygon-capacity-lookup` (PC21, PC22)

- Description "Polygon capacity lookup"; `disabled: true`; one input, `report_date` (optional). Variables: `outbound_dir: /data/outbound/polygon-capacity/`, `capacity_source: fixture`.
- Tasks: `validate_date` → `generate` (runtime; outputs `ratecard_card_name`, `ratecard_version_id`, `skipped_polygons`, `status`) → `validate_output` (`polygon_capacity`) → `deliver` (runtime `deliver()`) → `publish` (output + `DELIVERED` line) → `set_status`.
- Labels: `report_date`, `ratecard_card_name`, `ratecard_version_id`, `skipped_polygons`, `report=polygon_capacity`, `flow_revision`.
- The contract `contracts/polygon_capacity.yaml` (`header: false`, 8 columns, text/text/text/date/date/text/text/integer, all required), with Mediation and the CSP named as its readers.

### D9 — Codes added to the register

`NO_RATECARD_NAMED`, `MULTIPLE_RATECARDS_NAMED`, `CAPACITY_SOURCE_UNAVAILABLE`; `SKIPPED` reason `CAPACITY_MISSING` (the other Part B codes are already in §6).

---

## Implementation

1. **Role:** `GRANT SELECT ON product.product_offering_price TO reporting_runtime`.
2. **Infra:** the `polygon-capacity` share, environment storage and mount; rename rpt01's share to `platform-check` and its mount path; dev bind mount; README _Outbound destinations_ row (D1).
3. **Runtime:** `common/delivery.py`; `polygon_capacity/{__init__,extract,capacity_source,builder,__main__}.py`; `codes.py`; move `platform_check` onto `deliver()`.
4. **Flow and contract:** `report-polygon-capacity-lookup.yaml` (disabled), `contracts/polygon_capacity.yaml`.
5. **Tests:** fixture rate card V1/V2/V3 and a product price naming it; fixture capacity file; the suites below.

## Tests

P-T1–P-T14 (§B.3) are the acceptance set, run with the fixture capacity source. Tests run the flow by temporarily enabling it in the local test namespace only; the deployed flow stays disabled.

| # | Test | Expected |
|---|---|---|
| P-T1–P-T14 | §B.3 | as the plan |
| R04-T1 | Card from the product | with one `usage_rate` price naming `CARD_X`, the file uses `CARD_X`'s version; label `ratecard_card_name=CARD_X` |
| R04-T2 | Card name changes over time | a price naming `CARD_X` until 20261020 and `CARD_Y` from 20261021: `report_date=20261020` uses `CARD_X`, `20261026` uses `CARD_Y` |
| R04-T3 | No card / two cards | FAILED `NO_RATECARD_NAMED` / `MULTIPLE_RATECARDS_NAMED` naming both |
| R04-T4 | Missing capacity | a row the fixture source returns `None` for → `SKIPPED … CAPACITY_MISSING`, WARNING |
| R04-T5 | No overwrite (guardrail 8) | second delivery of the same name → FAILED `FILE_ALREADY_EXISTS`; the first file is byte-identical; no `.tmp` left |
| R04-T6 | Interrupted write | a failure injected between copy and rename leaves no target file and no temp |
| R04-T7 | Disabled | the deployed flow has `disabled: true` and can't be started |
| R04-T8 | Share isolation | the `polygon-capacity` share is its own share on the reporting account; a read-only SAS for it can't list or read the `platform-check` share (bicep what-if + one Azure check in the dev subscription) |

## Docs to sync in the same change set

- `_newmodule-reporting-plan.md`: PC1 (card from the product, D2); PC12 and RF8 (one share per destination, D1); new open item **RF-OI2** (reader access: SAS issuance, storage and rotation; HTTPS capability of Mediation and the CSP).
- `specs/rpt01-namespace-role-and-outbound.md` D7: the share layout is per destination (D1).
- `rptmgmt-architecture.md` §3, §4; `rptmgmt-code-standards.md` §5.4 (`common/delivery.py`), §6 (D9), §7 (`product_offering_price` moves from rpt09 to rpt04), §8; `wfm-architecture.md` §6 and §10.
- `rptmgmt-progress-tracker.md`, `specs/rpt00-build-plan.md` status.

## Verification checklist

1. P-T1–P-T14 and R04-T1–T8 pass; the flow is deployed disabled.
2. rpt01–rpt03 suites still green (the platform check now uses `deliver()`).
3. Docs synced (above).
