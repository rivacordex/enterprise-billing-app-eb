# Rating Management — Update Overview: PER_UNIT RAN-Usage Rating

**Reference:** `_change-rating-configuration-plan.md`
**Scope of this update:** Workstream A (rating engine), B (customer MNO key), D (seeds). Workstream C (product-management UI) is deferred to a follow-up phase.
**Operated by:** BSS IT Operations.

## Overview

The Enterprise Billing rating module ingests raw RAN (Radio Access Network) usage records for mobile network operators, resolves each record to the right subscriber, prices it against that subscriber's product, and loads immutable rated usage into `rating.udr_rated` for downstream bill-run. This update defines the **actual PER_UNIT business logic** for the `rating-engine-ran-usage` flow (`PRP → RP → RL`), replacing the placeholder `FLAT`-only scaffolding the engine ships with: it builds the real subscriber resolver (input MNO → customer → subscription), computes `rate × usage_volume` in exact decimal, and enforces data integrity (subscriber identity, completeness, duplicates, field agreement) with hard-stops **before any money is written**. Product and customer configuration is seeded/manual for this phase.

## Goals

1. Replace the placeholder subscriber resolver (which treats the fed value as an already-resolved `product_inventory_id`) with the real chain: input `mno_public_id` → `party_role_specification` → customer → the RAN_USAGE subscription.
2. Implement `PER_UNIT` rating (`ratePerUnit × usage_volume`) in Python `Decimal` with `HALF_UP` rounding, replacing the `FLAT` (quantity-ignored) computation.
3. Guarantee every record rates against the correct subscription via a **three-factor identity lock**, all hard-stop.
4. Enforce input integrity before rating: no missing columns/data, no duplicates, full ratecard↔input mapping (both directions), and `service_code` + `udrType` agreement.
5. Source the rate and the unit from the **product definition** (scalar `usage_rate` component + its `unit_of_measure`), never from the feed or the ratecard's `rate_per_unit`.
6. Keep reload/reprocessing on the existing flow (`batch_run_num` + rm10 supersession); fail the whole batch on any parse failure (`reject_threshold: "0"`).
7. Make the input filename/landing contract and the completeness enforcement mode **configurable flow variables**.
8. Align month/partition boundaries and datetime parsing to the **system timezone** (`Asia/Kuala_Lumpur`).
9. Correct the data-model names so they say what they hold: `udr_rated.udr_subscription_ref_id` = the subscription instance; `ratecard_ran_usage_lkp.lkp_subscriber_ref_id` = the customer.

## Core user flow (start to finish)

1. **Configure the product (seed/manual).** Create the RAN offering with specs `udrType = "RAN_USAGE"`, `singleSubInstPerCust = "true"`, `productCardLookUp = "RATECARD_RAN_USAGE_LKP"`, and one **scalar** `usage_rate` price component (`ratePerUnit` set, `rateCardLookUp = null`, `plaSpecId = null`, `unit_of_measure = "Mbps"`).
2. **Configure the customer (seed/manual).** Set `customer.party_role.party_role_specification = {"mnoPublicKey1": "MNO-001"}`; create the customer's single RAN subscription (`inventory.product_inventory`), pinned to the offering (`singleSubInstPerCust` blocks a second RAN subscription).
3. **Provision the ratecard.** Upload and activate a `ratecard_version`; each `ratecard_ran_usage_lkp` row maps `mno_public_key | commercial_unit_public_key | polygon_id` → `lkp_subscriber_ref_id = party_role_id`, plus `state`, `district`, `service_code` (and `rate_per_unit` left NULL/unused).
4. **File arrives.** `rating-input-file-<YYYYMMDDHHMI>.udr` lands in `/data/landing` (no header; CSV content; 7 columns: `mno_public_id, commercial_unit, polygon_id, datetime_YYYYMMDDHHMI, usage_volume, district_name, service_code`).
5. **Trigger + pre-rating (PRP).** The `PT1M` file trigger fires; PRP claims the batch (`UNIQUE (file_key, batch_run_num)`), parses per `feed_profile`, and runs every validation — structural (missing column/data), duplicate (deduped on `trunc(start_datetime, month) | mno | cu | polygon`), the three identity locks, `service_code` verify, ratecard↔input completeness (both directions), and `udrType` confirmation. Any integrity failure **hard-stops the whole batch** (`reject_threshold: "0"`).
6. **Rating (RP).** RP resolves the subscriber (`party_role_id` + `product_inventory_id`) and the rate (scalar `usage_rate` as-of `start_datetime`), computes `PER_UNIT` (`ratePerUnit × usage_volume`), sets `udr_usage_unit` from the product's `unit_of_measure`, snapshots the price/version fields, and emits rated chunks.
7. **Loading (RL).** RL inserts the rated rows into `rating.udr_rated` at status `RATED` in one transaction, supersedes any prior live rows for the same `file_key`, reconciles `parsed = rated + rejected + discarded`, then archives the file `landing/ → archive/`.
8. **Consume + operate.** Rated usage is available for bill-run. The operator monitors the run; on a hard-stop, they fix the source/config and **re-drop the same filename** to reprocess (supersedes the prior attempt).

## Features (by category)

**Input & collection**
- Configurable landing contract: `landing_dir` (`/data/landing`) and `file_key_rule` (retargeted to `^(?P<file_key>rating-input-file-\d{12})(?:_v\d+)?\.udr$`).
- Header-less CSV parsing of the 7-column `.udr` feed via the `feed_profile` flow variable; the feed carries **no unit** (unit comes from the product).
- Datetime parsed in the system-config timezone (`Asia/Kuala_Lumpur`).

**Pre-rating validation (PRP) — all hard-stop unless noted**
- Structural checks: every row has all columns, all columns have data.
- Duplicate detection on the identity key `trunc(start_datetime, month) | mno | cu | polygon` (one usage record per cell per month).
- **Three-factor subscriber identity lock:** (1) resolve via `party_role_specification` → `party_role_id`; (2) ratecard `lkp_subscriber_ref_id` must equal that `party_role_id`; (3) resolved offering family id `COALESCE(family_offering_id, product_offering_id)` must equal the pinned flow variable.
- `service_code` verified against the matched ratecard row.
- Ratecard↔input completeness: every active ratecard entry must appear in input (default `HARD_STOP`, configurable to `WARN` via `ratecard_coverage_enforcement`); every input row must map to a ratecard entry (`HARD_STOP`).
- `udrType` (`RAN_USAGE`) confirmed against the offering's `udrType` spec.
- All-or-nothing on parse failure (`reject_threshold: "0"`).

**Rating (RP)**
- Real subscriber resolver (`party_role_specification->>'mnoPublicKey1'` → customer → RAN_USAGE subscription); empty `{}` spec → `UNKNOWN_SUBSCRIBER`.
- `udr_rate_type` derived from `component_type` (`usage_rate → PER_UNIT`).
- `PER_UNIT` compute: `udr_rated_price_raw (18,6) = ratePerUnit × usage_volume`; `udr_rated_price (18,2) = round(raw − discount, HALF_UP)`; discount `= 0`.
- Explicit `perUnitRateDetailSchema`: `{ rateType: "PER_UNIT", ratePerUnit, quantity, amountRaw }` (Zod + Python mirror).
- `udr_usage_unit` sourced from the product's `usage_rate.unit_of_measure`.
- Loud `CARD_DRIVEN_RATING_UNSUPPORTED` error if a card-driven `usage_rate` is ever resolved (not built).

**Loading (RL)**
- Unchanged behavior, verified: single-transaction `COPY` insert at `RATED`, rm10 supersession by `file_key`, reconciliation identity, archive-after-commit.
- Verified for the new `raw ≠ rated` divergence PER_UNIT introduces and the `udr_rate_detail` JSON contract.

**Product & customer configuration**
- Product specs: `udrType`, `singleSubInstPerCust`, `productCardLookUp` (seed data, no schema change).
- Scalar `usage_rate` price component (existing pricing invariant untouched).
- MNO key on `party_role_specification` (`mnoPublicKey1`; path pinned; index deferred).
- Product lifecycle `DRAFT → TESTING → ACTIVE → OBSOLETE → RETIRED`; a price change is a new offering version with grandfather-on-ACTIVE (single price card, no future-dated secondary).

**Data model & DDL (fresh-install, edit-in-place)**
- Rename `udr_rated.udr_subscriber_ref_id` → `udr_subscription_ref_id` (column + index + all call sites incl. the bill-run repo).
- `period_of()` truncation timezone set to the system-config zone (deploy-time constant).
- Tighten the live-row unique constraint to `(partition_period, udr_key, is_live)`.

**Reload & reprocessing**
- Re-drop the same filename → same `file_key`, incremented `batch_run_num`, prior live rows superseded. The tightened live-row constraint backstops accidental overlap.

## In scope (what we are building)

- The real subscriber resolver in `rp.py` (party_role_spec → RAN_USAGE subscription).
- `PER_UNIT` rating math + `perUnitRateDetailSchema` (Zod + Python mirror).
- All PRP validations above, including the three-factor identity lock and the widened dedup key.
- The 7-column `feed_profile`, `file_key_rule` retarget, `ratecard_coverage_enforcement`, and `reject_threshold: "0"` flow variables.
- Product specs `udrType` / `singleSubInstPerCust` / `productCardLookUp` and a scalar `usage_rate` price (seed).
- Customer `party_role_specification` MNO-key shape + the one-MNO→one-customer PRP guard.
- The three `udr_rated` DDL touches: the `udr_subscription_ref_id` rename, the `period_of()` timezone constant, and the live-row constraint tighten.
- Scope-doc reconciliation: update `ratemgmt-ai-workflow-rules.md` (§2.5/§3), `project-overview`, `code-standards` (§2.3) to bring PER_UNIT + the real resolver in scope; banner the affected rm specs (`rm01/06/07/08/09/10/12`); banner/update pm57a (ratecard `lkp_subscriber_ref_id` semantics).
- Test coverage for all new paths + the three regressions (FLAT→PER_UNIT refresh; dedup widening; input→ratecard behavior change).

## Out of scope (what we are not building)

- **Workstream C — Product-management UI** (list/view/amend/retire) and the `product_catalog` permission — deferred; config is seed/manual this phase.
- **`singleSubInstPerCust` ordering-layer enforcement** — no code guard this phase (seed discipline only); lands with the ordering UI.
- **Maker-checker** on product lifecycle — single-operator `MANAGER`.
- **Multi-MNO-per-customer** (`mnoPublicKey2..N`) — the resolver is written as "first of N" but only the single key is wired.
- **Card-driven PER_UNIT rating** (`PLA_USAGE_RATE`) — not built; RP raises `CARD_DRIVEN_RATING_UNSUPPORTED`.
- **Other rate types** (TIERED_GRADUATED / TIERED_VOLUME / BLOCK / PERCENTAGE / ZERO_RATED) — enum-present, unbuilt.
- **Usage-level discounts** — all discount fields `0`/NULL.
- **Effective-dated pricing for existing customers** — grandfather-until-re-subscribe only.
- **Normalized `customer_mno_key` table + DB uniqueness** — jsonb + PRP runtime guard for now.
- **A `party_role_specification` index** — deferred (tiny table at pilot).
- **Any data migration** — the two constraint/function DDLs and the rename are edit-in-place on an empty `udr_rated` (fresh-install regime).

## Success criteria (what "done" looks like)

1. A sample `rating-input-file-<YYYYMMDDHHMI>.udr` dropped in `/data/landing` produces `rating.udr_rated` rows at status `RATED` where `udr_rate_type = "PER_UNIT"`, `udr_rated_price_raw = ratePerUnit × usage_volume`, and `udr_rated_price = round(raw, HALF_UP)` — verified end-to-end (the refreshed rm13 journey).
2. `udr_subscription_ref_id` = the resolved `product_inventory_id`; `udr_usage_unit` = the product's `unit_of_measure`; `udr_rate_detail` validates against `perUnitRateDetailSchema`.
3. Each of the three identity locks hard-stops the batch on a forced mismatch (bad MNO key, wrong ratecard `lkp_subscriber_ref_id = party_role_id`, wrong pinned family id), and a customer with an empty `{}` spec yields `UNKNOWN_SUBSCRIBER`.
4. A file with a missing column, a blank field, a duplicate `(month|mno|cu|polygon)` row, an unmapped input row, a `service_code` mismatch, or a missing ratecard polygon (under `HARD_STOP`) refuses the **whole batch**; the same missing-polygon file under `WARN` rates and logs the gap.
5. A customer holding a second (non-RAN) active subscription still resolves to the RAN subscription (offering filter), and a second RAN subscription is rejected at ordering (`singleSubInstPerCust`).
6. Re-dropping the same filename supersedes the prior batch; a same-cell/same-month second live row is rejected by the tightened constraint.
7. Month bucketing and datetime parsing use `Asia/Kuala_Lumpur`; a record near a month boundary lands in the correct Malaysian-calendar month.
8. The bill-run read path resolves usage through `udr_subscription_ref_id` with no broken reference after the rename.
9. The rating test suite is green: all new-path tests pass, and the three regressions (R1 FLAT→PER_UNIT, R2 dedup widening, R3 input→ratecard hard-stop) are covered.
10. The scope/rules docs and rm-spec banners are updated so the suite tracks PER_UNIT scope rather than the retired FLAT-only scope.
