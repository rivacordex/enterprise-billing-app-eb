# Billing Management — Bill Run — Phase 3 Update Overview

**Source of truth for this update:** `_updatemodule-billing-billrun-phase3-plan.md`.
**Updates:** the phase-2 wiring in `_updatemodule-billing-billrun-phase2-plan.md`, the phase-1 design in `_newmodule-billing-billrun-plan.md`, and the boundary in `_newmodule-billrun-rating-workflow-plan.md`.
**Amends (rating module):** `ratemgmt-architecture.md` Invariant #6 — authorized by Khek as rating module owner, 2026-09-13.
**Users:** Revenue Operations (RevOps — business, works only in the app) and BSS Ops (technical, works at the Kestra engine layer).
**Review status:** ENG CLEARED — `/plan-eng-review`, 2026-09-14. 11 findings walked and folded; see `_assessment-gstack-review-report-billrun-phase3.md`. One accepted residual: posted `customer_bill_line` rows have no DB-level immutability trigger and the `charge_checksum` is not re-verified after posting, so post-posting line tampering has no active detection until a re-verification path is added.

## Overview

The Bill Run module is where Revenue Operations executes and controls monthly bill runs: materialising the run for each bill cycle, turning each account's charges into a draft bill, approving it under a four-eyes gate, posting one `INV` document per account into the ledger, and distributing the resulting invoices and reports. Phase 2 delivered a complete control plane — trigger, approve, reject, rerun, cancel, post, RBAC, audit, and the `billrun_runtime` two-writer grant boundary — but no compute plane: `bill_run_processing` and `bill_run_distribution` are no-op `Log` placeholders, so a run advances its state machine and produces no bills, and distribution writes each artifact back to the store it came from. Phase 3 builds the compute plane. It replaces the processing placeholder with real validation, claim, aggregation, taxation and verification; introduces `billing.customer_bill_line` as the bill's stored charge record so an invoice has a durable face instead of one re-derived from a live operational table; sources recurring charges by deriving them from `inventory.product_inventory` rather than from rated usage; replaces the loopback distribution mock with per-invoice SFTP transport; and — for the first time — runs the whole thing against real Postgres, real Kestra, a real blob store and a real SFTP endpoint.

## Goals

1. Replace the `bill_run_processing` placeholder with a **real flow** whose Validation, Collection, Aggregation, Taxation and Verification stages do real work and POST real stage and terminal signals.
2. Add **`billing.customer_bill_line`** — one row per `(product_offering_id, udr_type)` per bill, with `gross_amount` / `discount_amount` / `net_amount` — as the layer between the `customer_bill` header and the underlying charge records.
3. Make the Collection stage **resolve the billing account for real**, via `udr_rated.udr_subscriber_ref_id → inventory.product_inventory → billing_account_id`, instead of reading a pre-stamped `billrun_ban_id` that only the sample seed writes.
4. **Derive recurring charges** from `inventory.product_inventory` into `customer_bill_line`, implementing the boundary already recorded in `_futurebuild_occ-charge-sourcing.md` §4.1/§8, with the resolved price snapshotted onto the line.
5. **Re-anchor `charge_checksum` on `customer_bill_line`**, hashing business content rather than surrogate ids, so it covers every charge source and stays reproducible from an archived invoice.
6. Close the **`udr_rated` lifecycle defects**: make reject a release rather than a park, and stop the rating engine superseding charges underneath a bill run that is open for review.
7. Replace the loopback distribution mock with **real SFTP transport** — one PUT and one outcome row per invoice PDF, plus the run report.
8. Rework the sample seed to emit **`RAN_USAGE` with a NULL `billrun_ban_id`**, matching what the real loader writes, so the correlation and aggregation logic is genuinely exercised.
9. **Execute the whole pipeline against real infrastructure at least once** — apply the five outstanding migrations, create the partitions, build the render image, bring up the blob store, and drive a run from `SCHEDULED` to `COMPLETED`.

## Core user flow (start to finish)

1. **Materialise.** RevOps opens Billing → Bill Runs. The page lazily inserts the current period's `bill_run` (`SCHEDULED`) for each active bill cycle. No scheduler.
2. **Trigger.** A `billrun_operate` user selects the operable run and clicks Run. The app snapshots eligible accounts into `bill_run_account`, sets the run to `PROCESSING`, and triggers **Kestra execution #1 (processing)** on the `billrun` engine with `{bill_run_id, period_start, period_end, ban_ids, attempt, gl_event_at}`.
3. **Validate (stage 2).** Per account, the flow confirms the account's claimable charges are consistent — currency matches `billing_account.currency`, coverage falls inside the period window. Because *which* rows belong to the account is only known after the subscriber→account correlation, that correlation is computed once and shared: Validation asserts against the correlated set rather than re-running the join. An account with nothing claimable is a zero-charge exception, not an error; a subscriber that resolves to no account is left unclaimed and surfaced as a per-record exception — never a silent drop, and never a reason to fail the account, since not knowing the account is the failure.
4. **Collect and claim (stage 3).** The flow resolves each unclaimed `rating.udr_rated` row to a billing account by joining `inventory.product_inventory` on `udr_subscriber_ref_id`, then claims the in-scope rows as `billrun_runtime`: `RATED → BILL_DRAFT`, stamping the six claim columns. Rows already claimed by another run are never re-claimed.
5. **Aggregate (stage 4).** The flow writes one `customer_bill` (`category='trial'`) per account, plus its `customer_bill_line` rows. Usage lines roll the account's claimed `udr_rated` rows up to `(product_offering_id, udr_type)` — an account with 3 Nationwide 5G subscriptions and 500 IoT 5G SIMs gets 2 lines, not 503. Recurring lines are derived from the account's subscriptions active in the period, priced as-of against `product_offering_price` with any `order_item_price_override` applied, and the resolved price is snapshotted onto the line. `customer_bill.subtotal` is set to `SUM(net_amount)`.
6. **Tax and verify (stages 5–6).** The flow writes the tax line at the configured rate and recomputes `tax_total` / `total_amount` in SQL, then runs the verification checks — including the bill↔charge reconciliation, which asserts every `USAGE` line's `gross_amount` equals the SUM of the `udr_rated` rows that rolled into it. Execution #1 terminates at `PROCESSED`; it does not wait for approval.
7. **Review.** RevOps opens the drill-down: per-stage timeline, per-account totals, the account's `customer_bill_line` rows as the invoice's face, the underlying `udr_rated` records as the per-subscription drill-down, plus Uncharged, Errors, Distribution and Audit tabs. **Uncharged** now lists accounts that produced no charge line at all — an account with recurring charges and zero usage is billed, not uncharged. A reviewer can preview a draft PRO-FORMA invoice for any account (on-demand, watermarked, no invoice number, not stored).
8. **Correct (optional).** A `billrun_operate` user reruns selected accounts from a chosen stage. **Before the re-trigger, the prior attempt's claimed rows are released back to `RATED`** with their claim columns cleared — symmetric with reject. That is not housekeeping: Collection claims `RATED` only, so a row left at `BILL_DRAFT` by an abandoned attempt would be unclaimable by the next one and would silently drop off the bill. The trial `customer_bill` and its cascading `customer_bill_line` rows are then re-derived through `billing.billrun_delete_trial_bill(run, ban)` as a **whole-account replace** — every line for the account is deleted and re-inserted, never upserted one at a time — and identical inputs reproduce identical `line_no` values and an identical checksum.
9. **Reject (optional).** A `billrun_approve` user rejects the whole bill or selected accounts. The claimed rows are **released** — `status` returns to `RATED` and all four claim columns are cleared — and the `REJECTED_PENDING_REPROCESS` marker is stamped on each account's current stage row. The run stays `PROCESSED` and operable.
10. **Re-rate (optional).** Because the rejected rows are released and live again, BSS Ops can now reload a corrected usage file: the rating engine supersedes them normally and inserts the replacements. While a run's rows are still claimed, that reload is refused whole with `LOAD_BLOCKED_INFLIGHT` (MINOR), naming the blocking `bill_run_id`. The operational order is: **reject or cancel the open run first, then reload.**
11. **Approve.** A different `billrun_approve` user (≠ the final trigger actor) approves. Pre-approval checks pass; claimed rows flip `BILL_DRAFT → BILL_APPROVED`; the run moves to `APPROVED` then `POSTING`.
12. **Post, render and store.** Per account, in its own transaction: compute `charge_checksum` over the account's `customer_bill_line` rows, create and auto-post one `INV` through the Accounts document engine (consuming the invoice number), then render the final invoice PDF and store it in `bill_run_invoices`. Failed accounts are marked `SKIPPED`. When all accounts are terminal the run reaches `INVOICED` and the next cycle unblocks.
13. **Distribute.** The app triggers **Kestra execution #2**, handing it one `invoice_pdf` artifact per stored invoice plus one `report_csv`, and the environment's target list. The flow downloads each artifact from blob storage by `blob_ref` and SFTPs it — invoices to `{remote_base}/invoices/{YYYY-MM}/{INV}.pdf`, the report to `{remote_base}/reports/{YYYY-MM}/{bill_run_id}-report.csv` — retrying once on failure, then POSTing a `DELIVERED` or `FAILED` outcome for every artifact without exception.
14. **Complete.** Every mandatory artifact delivered **to every mandatory target** → `COMPLETED`. The expected count is artifacts × mandatory targets, and the latest outcome per `(target, artifact_ref)` decides — so a run with two mandatory targets cannot complete on one target's deliveries alone. Any mandatory artifact whose latest outcome is `FAILED` → `DISTRIBUTION_FAILED`, rerunnable via `rerunDistribution`, which re-triggers only the failed artifacts and never touches posted invoices.

## Features by category

**Processing flow (the compute plane)**

- Real `bill_run_processing` Kestra flow: per-account fan-out over Validation → Collection → Aggregation → Taxation → Verification, with real per-stage M2M signals and real `errors` / `finally` terminal pushes replacing the `Log` stubs.
- Subscriber→account correlation in Collection, joining `inventory.product_inventory`, following the set-based shape already proven in `rl.py`'s `_CURRENCY_SQL`.
- Two charge sources in one aggregation pass: `USAGE` claimed from `rating.udr_rated`, `RECURRING` derived from `inventory.product_inventory`.
- A **new recurring-price resolver** in the flow: `price_type='recurring'` resolved as-of, with `recurring_charge_period_length`/`_type` mapped onto the cycle, multiplied by `product_inventory.quantity`, and an explicit tiered / lookup-miss policy (this is new billing compute, not a reuse of the usage resolver). The resolved price is snapshotted onto the line, and on rerun the flow reads the snapshot rather than re-resolving, so a backdated catalog price cannot silently re-price a closed period.
- All bill-data compute stays in the flow as `billrun_runtime`; no app-side trial-bill computation is reintroduced.

**Charge model**

- `billing.customer_bill_line`, partitioned on `period_partition`, 7-year detach-and-archive matching `customer_bill`, `ON DELETE CASCADE` to its header so the existing scoped `billrun_delete_trial_bill` covers rerun re-derivation.
- Grain `(product_offering_id, udr_type)` rolled up across subscriptions, computed in one place so per-product configurability can be added later without reshaping the table.
- `source` discriminator (`USAGE` / `RECURRING` / `OCC` reserved) and `line_type` (`charge` / `discount` / `adjustment`).
- Three money columns — `gross_amount`, `discount_amount`, `net_amount` — with `customer_bill.subtotal = SUM(net_amount)` as a stated invariant, plus the `udr_rated`-shaped discount fields held ready for a later discounting capability.
- Deterministic `line_no` ordered on the grouping key, so a re-derived or re-issued invoice keeps its line numbering.
- `udr_count` and the grouping key stored per `USAGE` line, making the bill↔charge reconciliation a real assertion rather than a tautology.
- **Whole-account line replace** as `RECURRING`'s exactly-once mechanism. Unlike `USAGE`, a recurring line carries no row-grain claim marker, so nothing at the row level prevents a duplicate — the guarantee is that re-derivation deletes *all* of an account's `customer_bill_line` rows through the scoped `billrun_delete_trial_bill` and re-inserts them, and the flow never upserts a line individually. `billrun_runtime` therefore holds no table-level `DELETE` on `customer_bill_line`, so the only deletion path is the scoped function.

**Integrity and the rating boundary**

- `charge_checksum` re-anchored on `customer_bill_line`, computed entirely in SQL in a new `customer-bill-line.repository.ts`, hashing `(source, ref_product_offering_id, udr_type, line_type, gross_amount, discount_amount, net_amount)` rather than surrogate ids — all three money columns, so a discount that preserves net stays tamper-evident.
- Reject becomes a release: `markRejected` clears `status` to `RATED` and NULLs all four claim columns; Collection's claimable set narrows to `RATED` alone.
- Rating Invariant #6 widened to refuse a batch colliding with any live **claimed** row (`BILL_DRAFT` or `BILL_APPROVED`), not only approved ones.
- `rating.rating_status_guard` trigger in `rating-db-roles.sql`, symmetric to the existing `billrun_status_guard`, refusing any `rating_runtime` UPDATE that moves a row out of `BILL_DRAFT` / `BILL_APPROVED` — the database-level guarantee behind the widened application check.
- New `LOAD_BLOCKED_INFLIGHT` event code (MINOR, not auto-clearing) alongside `LOAD_BLOCKED_BILLED` (MAJOR), so a routine scheduling conflict does not share an alarm with an irreversible one.
- Guardrail test asserting no code path writes `inventory.product_inventory.billing_account_id`, protecting the resolve-at-bill-run-time assumption.

**Distribution**

- Real `bill_run_distribution` Kestra flow: Azure Blob download by `blob_ref` → SFTP upload → per-artifact outcome POST, with `errors` / `finally` terminal pushes.
- Two targets, environment-selected: `loopback` in dev/test (preserving the `force_fail` failure-injection path), `sftp` in production.
- Per account, per PDF: one PUT and one `bill_run_distribution` row per invoice, plus one for the run report.
- One in-execution retry on upload failure, then a reported `FAILED`; the outcome POST is guaranteed even when the upload fails.
- SSH key authentication in every environment, host-key verification enabled, private key held as a Kestra Secret sourced from Key Vault.
- Separate remote subtrees for invoices and the run report.

**Seed and verification**

- Sample `udr_rated` factory emits `RAN_USAGE` with `billrun_ban_id` left NULL, matching the real loader; `SUBSCRIPTION_RECURRING` rows are retired.
- Two seed profiles sharing one factory: `ci` (small, unconditional) and `volume` (realistic `RAN_USAGE` load, run deliberately).
- Scenario coverage: recurring + usage on one account, multiple subscriptions of one offering, recurring-only, no-charges-at-all, partial period, and a `BILL_NOTUSED` row.
- Unit 0 environmental gate: apply migrations, create partitions, run the DB-gated suites, build the render image, bring up the blob store, run the live-Kestra smoke, stand up SFTP and verify worker-image plugins.

## In scope

- `billing.customer_bill_line` table, partition, cascade FK, and its repository.
- Real `bill_run_processing` flow — validation, correlation-based collection, two-source aggregation, taxation, verification, real stage and terminal signals.
- Recurring charge derivation from `inventory.product_inventory`, with as-of pricing and the price snapshot.
- `charge_checksum` re-anchored on `customer_bill_line`; `rated-lines.repository.ts` trimmed to `listClaimedForAccount` and its header comment corrected.
- `markRejected` release semantics; Collection's claimable set narrowed to `RATED`.
- Widened `rl.py` `_GUARD_SQL`, renamed `find_bill_approved_collisions`, the amended Invariant #6 text, and the `rating_status_guard` trigger — shipped as one change set.
- `LOAD_BLOCKED_INFLIGHT` event code: catalog seed row, `RATING_EVENT_CODES` constant, and the emitting flow.
- Widened `billrun_runtime` grants: `SELECT` on `inventory.product_inventory`, `product.product_offering`, `product.product_offering_price`, `ordering.order_item_price_override`; `INSERT`/`SELECT` (no table-level `DELETE`) on `billing.customer_bill_line`. Plus `SELECT`-only for `app_runtime` on `customer_bill_line` (posting checksum + final render), never DML.
- Real `bill_run_distribution` flow with SFTP transport, two environment-selected targets, one retry, key auth and host-key verification.
- Widened `isLaunchedDistributionIdentity` to a known-target set; multi-target `recomputeDistributionStatus` — `expected` scales by mandatory-target count and latest-outcome dedup keys on `(target, artifact_ref)`, so completion requires all mandatory targets.
- Uncharged redefined as "no `customer_bill_line`"; `BILL_NOTUSED` given its own per-record surface.
- Sample seed reworked to `RAN_USAGE`, with the `ci` and `volume` profiles and the six scenarios.
- The bill↔charge reconciliation check carried over from `TODOS.md`.
- Guardrail test on `product_inventory.billing_account_id`.
- **Retire `BILLRUN_PLACEHOLDER_MODE`** — delete the flag, `PlaceholderBanner`/`PlaceholderBadge` and every call site. Its copy ("the billing steps are placeholders") is false once the real flows deploy. The `_SAMPLE_` seed marking, the unclaimed-on-seed rule and the `db:seed-sample` prod guard are **kept** and extended to both seed profiles; `BILLRUN_DISTRIBUTION_FORCE_FAIL` is **kept** (it drives the `DISTRIBUTION_FAILED` test path).
- Unit 0: migrations `0033`/`0035`–`0038` applied, `db:setup-partman-billing` run, DB-gated suites executed, Chromium render image built, blob store up, live-Kestra smoke run, SFTP endpoint stood up and worker-image plugins verified.

## Out of scope

- **OCC — one-time and multi-cycle charges.** The `source` value is reserved and `line_type` exists, but the occurrence ledger is not built; it stays an origination-domain design per `_futurebuild_occ-charge-sourcing.md` §6. Direct one-offs remain available as manual DBN/ADJ/CRN in Accounts → Transactions.
- **Discount logic.** The columns and `line_type` exist; nothing computes, applies or configures a discount.
- **Configurable line grain.** The fixed `(product_offering_id, udr_type)` default only; no configuration surface, owner or UI.
- **A tax-rate catalog.** Taxation remains the single configured `BILLRUN_TAX_RATE`; no jurisdiction or category rules.
- **A recurring-charge rating capability.** Recurring is derived by the bill run; giving the rating engine a second, non-file ingestion mode is a rating-module design exercise.
- **A real invoice layout.** The template stays the phase-2 mock; `customer_bill_line` changes what it reads, not how it looks.
- **Distribution targets beyond SFTP and loopback** — no email, customer portal, AR/collections feed or statutory submission; no target catalog table.
- **The `bill_run_output` table** and per-run reports as stored records; the run report remains a transient distribution payload.
- **The adjustment/credit-note remedy** for a `LOAD_BLOCKED_BILLED` refusal.
- **Outcome-completeness alarming in the rating module** — a `REFUSED` batch still satisfies the file-arrival check, so nothing raises `FILE_NOT_RECEIVED`; recorded as a rating-module follow-on.
- **Migration to Kestra Enterprise** and scoped per-flow tokens.
- Proration, off-cycle runs, multi-frequency cycles (unchanged from phase 1). Consequence made explicit this phase: a partial-period account (mid-period start/cease/suspend) is `EXCLUDED` before the flow runs, so it forgoes that month's recurring **and** usage charges and bills from the next full cycle. The seed's partial-period scenario proves the exclusion fires, not two-source aggregation.

## Success criteria

- A triggered run starts a real processing execution that claims `udr_rated` rows whose `billrun_ban_id` was NULL, resolving each to a billing account through `inventory.product_inventory`, and reaches `PROCESSED` with real bills written.
- An account with 3 subscriptions of one offering and 500 of another produces exactly 2 charge lines; `SUM(customer_bill_line.net_amount)` equals `customer_bill.subtotal` for every bill.
- An account with both recurring and usage charges produces one line per `(product_offering_id, udr_type)`, each carrying its price snapshot.
- A **recurring-only** account with zero usage produces a non-empty bill whose `charge_checksum` is not `md5('')` — and is not listed as Uncharged. An account with no charge lines at all is.
- Re-deriving a bill from unchanged inputs reproduces identical `line_no` values and an identical `charge_checksum`; the checksum is computable from the bill's content without reading surrogate ids; altering any posted line is detected.
- Every `USAGE` line's `gross_amount` equals the SUM of the `udr_rated` rows that rolled into it; non-`charge` line types are excluded from the check.
- A `udr_rated` row with an unresolvable subscriber stays `RATED` and unclaimed, shows on the exception surface, does **not** block approval, and is claimed by the next run once inventory is corrected.
- A subscription whose recurring price is missing or `tiered` sends **only its own account** to `PROCESSING_FAILED` with `RECURRING_PRICE_NOT_FOUND` / `RECURRING_PRICE_UNSUPPORTED`; every other account still bills, and no zero-amount line is fabricated.
- Reject releases the claimed rows to `RATED` with all four claim columns cleared; a rating reload then supersedes those released rows normally; the subsequent rerun claims only the successors and raises no `udr_rated_live_uq` violation.
- **[CRITICAL] No claim survives an abandoned attempt.** After a rerun that follows a partial processing failure, no `udr_rated` row remains at `BILL_DRAFT` from the prior attempt, and the re-run bill contains every charge the first attempt had claimed — the regression test for the silent under-bill.
- Re-deriving an account's bill replaces **all** of its `customer_bill_line` rows; running Aggregation twice for one account leaves exactly one recurring line per subscription, never a duplicate.
- A run with two mandatory targets reaches `COMPLETED` only once every artifact has delivered to **both**; delivering every artifact to one target alone leaves the run short of its expected count.
- A rating reload colliding with a `BILL_DRAFT` row is refused whole with `LOAD_BLOCKED_INFLIGHT` at MINOR, `udr_batch.status = REFUSED`, naming the blocking `bill_run_id`; the same collision against `BILL_APPROVED` still raises `LOAD_BLOCKED_BILLED` at MAJOR.
- With the application pre-check bypassed, a direct `rating_runtime` UPDATE moving a `BILL_DRAFT` row to `SUPERSEDED` is refused by `rating_status_guard`.
- `billrun_runtime` can write `customer_bill_line` and is still refused, per column and table, on `bill_run`, `bill_run_account`, `bill_run_account_stage`, `billing.document`, pgledger and `bill_run_invoices`.
- Each stored invoice PDF is SFTP'd to its own remote path and logged as a `DELIVERED` outcome; a forced mandatory failure yields `DISTRIBUTION_FAILED` and reruns only the failed artifacts; an upload that fails twice still POSTs `FAILED` rather than terminating silently; a duplicate outcome replays 200 and a stale-attempt outcome is swallowed.
- Both `loopback` and `sftp` targets can be launched in one run, and an outcome naming an unlaunched target is rejected with a 409.
- The `volume` seed drives a run to completion with Aggregation issuing a bounded number of statements rather than one per record, and line count tracking product footprint rather than record count.
- **Unit 0 exit:** migrations `0033`/`0035`–`0038` are applied, partitions exist, the DB-gated suites pass, the Chromium image is built, the blob store round-trips a checksum-matching PDF, and a phase-2-shaped run reaches `COMPLETED` against real infrastructure. Unit 0 proves the **foundation** on the placeholder flows — `customer_bill_line`'s own migration and partition registration are phase-3 work and are deliberately not among its five prerequisites, so Unit 0 passing is never mistaken for the phase-3 path working.
- **Phase exit:** a full journey passes end to end against the `ci` seed on real Postgres, real Kestra, a real blob store and a real SFTP endpoint — materialise → trigger → process → review → reject → re-rate → reprocess → approve → post → render + store → SFTP distribute → `COMPLETED`.
