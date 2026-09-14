# bm26 — Sample Seed → `RAN_USAGE`, Unclaimed (`ci` profile)

**Unit:** bm26 (Phase 3 · Phase L). **Boundary:** `db/seeds/sample` (`udr-rated-sample.ts`, `seed-billrun-sample.ts`) + the two sample-seed guardrails. **No schema, service, flow, or UI.** **Specs from:** `billmgmt-update-overview.md` (real-shaped usage), `billmgmt-code-standards.md` §9 (seed integrity guardrails), `bm00-build-plan.md` Unit 26, `_updatemodule-billing-billrun-phase3-plan.md` **D28/D32**. **Model:** the real loader `workflow-management/worker/workflow-engine/runtime/rl.py` (`build_chunk_rows`).

> **Framing.** Collection (bm27) resolves an orphaned usage row to its account and claims it. It cannot be demonstrated at all against today's seed, because the sample factory **pre-stamps `billrun_ban_id`** with the account — a shape the real rating loader never produces (`rl.py` leaves the four `billrun_*` columns NULL). This unit makes the seed's usage rows **indistinguishable from the real loader's output**: `udr_type = 'RAN_USAGE'`, `billrun_ban_id` NULL, `status = 'RATED'`, `_SAMPLE_`-marked — and adds a `ci` profile of six scenarios covering the shapes Collection/Aggregation must handle. Recurring charges are no longer fed through `udr_rated` at all (they are derived by the billing flow from `product_inventory` in bm29), so `SUBSCRIPTION_RECURRING` rows retire from the factory.

## Goal

Change the sample `udr_rated` factory to emit real-shaped `RAN_USAGE` rows with `billrun_ban_id` NULL (matching `rl.py`), retire `SUBSCRIPTION_RECURRING` from it, extend the `_SAMPLE_`/unclaimed rules to the new shape, and build a `ci` profile of six scenarios — so `db:seed-sample` produces a graph whose usage rows are indistinguishable from the real loader's, and the seed-marker/boundary guardrails pass against it.

## Design

**Structural decisions**

- **Match `rl.py` exactly (D28).** `rl.py`'s `build_chunk_rows` sets `status = 'RATED'` and writes **none** of `billrun_ban_id`/`billrun_ref_id`/`billrun_attempt`/`billrun_checksum` — a freshly loaded usage row is unclaimed and unattributed. The seed must produce the same: `billrun_ban_id` becomes **NULL** (was the account id). This is the single change that unblocks Collection — a row Collection can resolve is a row that does not already carry its account.
- **`RAN_USAGE`, not `SUBSCRIPTION_RECURRING` (Inv #1).** Usage is the only thing `udr_rated` carries into billing now. Recurring is billing compute (bm29), derived from `inventory.product_inventory`, never rated — so the factory's hardcoded `udr_type = 'SUBSCRIPTION_RECURRING'` becomes a parameter defaulting to `RAN_USAGE`, and the recurring emission is removed. The `udr_type` column has no DB CHECK (rating leaves it application-defined), so this is a value change, not a schema change.
- **The subscriber ref must correlate (bm27 dependency).** `udr_subscriber_ref_id` is what Collection joins to `inventory.product_inventory.product_inventory_id → billing_account_id`. The seed wires each `RAN_USAGE` row's `udr_subscriber_ref_id` to a **real seeded subscription's `product_inventory_id`**, so bm27's correlation resolves against live inventory rather than a synthetic key.
- **`ci` profile, six scenarios; `volume` deferred (Unit 26 note).** The `ci` profile covers: (1) recurring + usage on one account, (2) multiple subscriptions of one offering, (3) recurring-only, (4) no charges at all, (5) partial period, (6) a `BILL_NOTUSED` row. "Recurring" is represented by `product_inventory` subscriptions (via the real `createOrder → instantiateOrder` path already used by the seed), **not** by `udr_rated` rows. The `volume` profile is out of scope — its only visible result is a performance characteristic that needs aggregation to exist, so it merges into bm35.
- **Unclaimed-on-seed strengthens.** Previously "unclaimed" meant `billrun_ref_id`/`attempt`/`checksum` NULL with `billrun_ban_id` set; now all **four** claim columns are NULL. The marker guardrail's `billrun_ban_id` assertion flips accordingly.
- **Each downstream unit brings its own fixtures.** The `ci` profile is exactly the six scenarios above. The D32 unresolvable-subscriber orphan (bm27) and the broader exception cases (bm32) are added by those units to the seed as they need them — not pre-built here (no speculative scope, workflow-rules §3).

## Implementation

### 1. `db/seeds/sample/udr-rated-sample.ts` — real-shaped factory

- Add a `udrType` field to `SampleChargeSpec` (default `'RAN_USAGE'`); remove the hardcoded `udrType: "SUBSCRIPTION_RECURRING"`.
- Set `billrunBanId: null` (was `spec.ban`). `billrunRefId`/`billrunAttempt`/`billrunChecksum` stay `null`. The row is fully unclaimed, exactly as `rl.py` leaves it.
- Keep: `status: spec.status ?? "RATED"` (with `"BILL_NOTUSED"` override for scenario 6); `partitionPeriod: sql\`rating.period_of(...)\`` (never re-derived in JS); the `_SAMPLE_` provenance (`udrSourceFile = "_SAMPLE_billrun"`, `udrRefBatchId = "_SAMPLE_BATCH"`, `ratingEngineVersion = "_SAMPLE_"`); the usage columns (`udrUsageQuantity`/`udrUsageUnit`/`udrRatedPrice`/`udrCurrency`/`udrRateType`/`udrRateDetail`).
- `udrSubscriberRefId` is set by the caller to the seeded subscription's `product_inventory_id` (so bm27 correlation resolves).

### 2. `db/seeds/sample/seed-billrun-sample.ts` — the `ci` profile (six scenarios)

Keep the idempotent purge-and-rebuild keyed on `_SAMPLE_-BILLRUN-0001` and the real onboarding/order path. Replace the single fixed charge set with a `ci` scenario builder that produces, across the sample customer's accounts:

1. **Recurring + usage** — an account with a `product_inventory` subscription **and** `RAN_USAGE` rows whose `udr_subscriber_ref_id` = that subscription's `product_inventory_id`.
2. **Multiple subscriptions of one offering** — an account with several `product_inventory` rows of the same offering (Aggregation must roll them into one line, bm28) plus usage.
3. **Recurring-only** — an account with subscription(s) and **no** `RAN_USAGE` rows (bill comes only from bm29's recurring derivation).
4. **No charges at all** — an account with neither subscription nor usage (Uncharged, bm32).
5. **Partial period** — the mid-period-start account (the existing `isFullPeriod: false` BAN).
6. **`BILL_NOTUSED`** — a seeded `udr_rated` row at `status = 'BILL_NOTUSED'` (the per-record exception surface, bm32).

Retire the `SUBSCRIPTION_RECURRING` `udr_rated` emission entirely. Structure the entry point so the profile is selectable (`ci` now; `volume` reserved for bm35) without changing the default demo behavior.

### 3. Seed guardrails — extend, don't loosen

- **`tests/guardrails/billing-sample-seed-marker.test.ts`:** flip the unclaimed assertion from `expect(row.billrunBanId).toBe(BASE_SPEC.ban)` to `expect(row.billrunBanId).toBeNull()`; add a case asserting a default row is `udrType === "RAN_USAGE"`; keep the `_SAMPLE_` marker assertions on `udrSourceFile`/`udrRefBatchId`/`ratingEngineVersion` and the `RATED`/`BILL_NOTUSED` cases (all four `billrun_*` columns NULL).
- **`tests/guardrails/billing-sample-seed-boundary.test.ts`:** unchanged — `db:seed-sample` stays declared, prod-guarded, and absent from `db:setup` (D31/D32 seed provenance survives the placeholder-mode retirement, bm33).

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm23 (`customer_bill_line` schema present — build-order, so the graph the `ci` profile feeds is aggregatable by bm28); the delivered sample-seed machinery (bm15: `seed-billrun-sample.ts`, `udr-rated-sample.ts`, the `_SAMPLE_` provenance + prod guard); `inventory.product_inventory` (`billing_account_id`, `quantity`) populated by the seed's real order path.
- **Sequencing:** must land **before** bm27 — Collection needs rows carrying a NULL `billrun_ban_id`, which only this unit produces.

## Verification checklist

- [ ] The factory emits `udr_type = 'RAN_USAGE'`, `status = 'RATED'`, and **all four** `billrun_*` columns NULL — byte-for-byte the shape `rl.py` writes; no `SUBSCRIPTION_RECURRING` row is produced.
- [ ] Each `RAN_USAGE` row's `udr_subscriber_ref_id` is a real seeded `product_inventory_id`, so bm27's correlation resolves it to the right `billing_account_id`.
- [ ] `db:seed-sample` (`ci` profile) builds the six scenarios idempotently (re-run purges and rebuilds on `_SAMPLE_-BILLRUN-0001`).
- [ ] `billing-sample-seed-marker.test.ts` passes with the flipped `billrunBanId` (NULL) assertion and the `RAN_USAGE` assertion; every seeded row is `_SAMPLE_`-marked and unclaimed.
- [ ] `billing-sample-seed-boundary.test.ts` passes — `db:seed-sample` prod-guarded and absent from `db:setup`.
- [ ] `tsc`/lint/tests green; `billmgmt-progress-tracker.md` records bm26 delivered and notes `volume` deferred to bm35.
