# Billing Management Module — Project Overview

## Overview

The Billing Management Module is the section of the Enterprise Billing App (Telco)
where the **Revenue Operations (RevOps)** team executes and controls monthly bill
runs. It manages the operational instance of a billing cycle (`bill_run`), the
per-account state inside that run (`bill_run_account`, `bill_run_account_stage`),
the draft bill assembled for each billing account (`customer_bill`,
`customer_bill_line`, `customer_bill_tax_item`), the final stored invoice PDF
(`bill_run_invoices`), and the distribution outcomes (`bill_run_distribution`).
The module provides a "Billing" navigation section whose Bill Runs pages let RevOps
see which run is current for each cycle, trigger it, watch it progress stage by
stage, review every customer's draft bill (and a PRO-FORMA preview) on screen,
reject or rerun accounts while the run is unapproved, and — under a four-eyes gate —
approve it, which posts one `INV` document per billed account through the existing
Accounts document engine into pgledger, renders and stores each final invoice, and
distributes the invoices + run report over SFTP.

**The bill run performs no usage rating.** Usage is rated continuously by an
external engine and lands as already-rated Usage Detail Records in
`rating.udr_rated`; the bill run **collects (claims)** the records due for the
period and bills them. Recurring charges are **derived by the bill run** from
`inventory.product_inventory` (not rated). The run is orchestrated by a **workflow
engine** — deployed as **Kestra** (OSS), though the schema and app stay
vendor-neutral ("workflow" naming) — which runs the real compute pipeline as the
least-privilege `billrun_runtime` role and writes the bill data itself, signalling
the app on each stage (write-then-signal). The placeholder/stub-data mode of
earlier phases has been retired; the pipeline runs against real Postgres, real
Kestra, a real blob store and a real SFTP endpoint.

> **Current state (2026-10-12, verified against dev1 `614743a`).** The compute, posting, rendering and distribution
> planes are all built and real (Phases 1–3, bm01–bm35), and **Phase 4 is
> delivered (bm36–bm39):** the processor signal-back is real (bm36 —
> `bill_run_processing.yml` POSTs a per-stage `DONE` after each stage, a per-account
> HARD `FAILED`, and a run-level terminal `PROCESSING_FAILED` for a whole-execution
> failure via `errors: on_error` on `FAILED` / `afterExecution: on_killed` on a
> KILL, all real `http.Request` mirroring the distributor, bm34); the full local
> `SCHEDULED → COMPLETED` lifecycle is asserted end-to-end on the `ci` seed by the
> live-Kestra smoke (bm37); the production deploy path is deployable + wired, still
> gated (bm38); and bm39 audited the assembled phase and signed it off. A triggered
> run now drives itself `SCHEDULED → COMPLETED` on its own with no out-of-band calls;
> a contained per-account HARD failure leaves the run `PROCESSED` with the failed
> account skippable/rerunnable. **The one remaining item is the cloud cutover** —
> flipping the deploy flags and running the smoke against a real engine + SFTP — a
> gated ops step, not a module-build gap (see the Phase 4 section below).
> Taxation is a ratified `0.00` interim. **The Target Capacity Pricing update
> (bm40–bm46) is delivered** — a commitment floor + motivation discount for
> RAN_USAGE capacity offerings, computed as inline SQL in the existing
> `bill_run_processing` flow, plus a per-polygon invoice usage appendix (see the
> Target Capacity Pricing update section below; fully rolled up from the update
> overview on 2026-10-15). **Outstanding for that update:**
> the live-Kestra capacity journey (TC54) has no capacity-aware harness yet
> (`billmgmt-progress-tracker.md`), and **O-TC7** (partial-period capacity
> billing) remains an open business decision. **The Invoice Template update
> (bm47–bm63) is delivered** and folded below.

## Lifecycle

```
SCHEDULED → PROCESSING → PROCESSED → APPROVED → POSTING → INVOICED → DISTRIBUTING → COMPLETED
```

plus two rerunnable failure states `PROCESSING_FAILED` and `DISTRIBUTION_FAILED`,
and `CANCELLED`. `INVOICED` means financially complete (postings done, invoice
numbers consumed); `COMPLETED` means operationally complete. **Next-cycle
operability keys off `INVOICED`**, so a stalled distribution target can never block
next month's billing. Run status is always recomputed under a `bill_run` row lock
from `bill_run_account`, never by incrementing a counter.

## Core user flow

1. **Materialise.** RevOps opens Billing → Bill Runs. On load the page lazily
   inserts the current period's `bill_run` (`SCHEDULED`) for each active cycle
   (`ON CONFLICT (cycle, period_start) DO NOTHING`, concurrency-safe). No scheduler,
   cron, or background worker in the app. In-arrears window: a `cycle_day`-1 monthly
   cycle's July run appears on 1 August; `scheduled_run_date = period_end + 1`.
2. **Trigger.** A `billrun_operate` user selects the operable run and clicks Run.
   The service snapshots every eligible account into `bill_run_account` (freezing
   the population), sets the run `PROCESSING`, and triggers **Kestra execution #1
   (processing)** with `{bill_run_id, period_start, period_end, ban_ids, attempt,
gl_event_at}`. A second click while an execution is live is rejected.
3. **Process (execution #1, as `billrun_runtime`).** Per account, fanned out:
   - **Validation** asserts currency (`= billing_account.currency`) and window
     coverage against the correlated set (below). Zero-claimable is a zero-charge
     `DONE`, not an error.
   - **Collection** resolves each `RAN_USAGE` row `udr_subscription_ref_id →
inventory.product_inventory → billing_account_id` (set-based, once per run),
     then claims the in-scope rows `RATED → BILL_DRAFT`, stamping the six claim
     columns. An unresolvable subscriber is left `RATED`/unclaimed and surfaced,
     never dropped or failed.
   - **Aggregation** writes one `customer_bill` (`category='trial'`) plus its
     `customer_bill_line` rows at grain `(product_offering_id, udr_type)` — USAGE
     rolled from claimed `udr_rated`, RECURRING derived from `product_inventory`
     and priced as-of with the resolved price **snapshotted** onto the line.
     `subtotal = SUM(net_amount)`.
   - **Taxation** (interim `0.00`) and **Verification** (incl. bill↔charge
     reconciliation) run; execution #1 terminates at `PROCESSED` (it does not wait
     for approval).
4. **Review.** RevOps opens the drill-down: Workflow (stage timeline + pre-approval
   checks), Customers & Bills (`customer_bill_line` rows as the invoice's face, the
   `udr_rated` records as per-subscription drill-down, PRO-FORMA preview), Uncharged
   (accounts that produced **no** charge line), Errors, Distribution, and Audit tabs.
5. **Reject / Rerun (optional).** Reject (a `billrun_approve` action) or rerun (a
   `billrun_operate` action, mandatory reason, audit-before-retrigger) **releases**
   the claimed rows back to `RATED` with all four claim columns cleared, and
   re-derives the trial bill as a whole-account replace. While rows are still
   claimed, a rating reload is refused whole with `LOAD_BLOCKED_INFLIGHT`.
6. **Approve → Post.** A **different** `billrun_approve` user (≠ the final trigger
   actor) approves after the pre-approval checks pass; claimed rows flip
   `BILL_DRAFT → BILL_APPROVED`; the run moves `APPROVED → POSTING`. Per account, in
   its own transaction: compute `charge_checksum` over the account's
   `customer_bill_line` rows, create and auto-post one `INV` through the Accounts
   engine (consuming the invoice number), then render the final PDF and store it in
   `bill_run_invoices`. Failed accounts are `SKIPPED`; already-invoiced accounts are
   skipped on retry (resumable). When all are terminal the run reaches `INVOICED`
   and the next cycle unblocks.
7. **Distribute → Complete (execution #2).** The app triggers **Kestra execution #2**
   with one `invoice_pdf` artifact per stored invoice plus a `report_csv` and the
   environment's target list. The flow downloads each artifact from blob storage and
   SFTPs it to its remote path, POSTing a `DELIVERED`/`FAILED` outcome per artifact.
   Every mandatory artifact delivered to every mandatory target → `COMPLETED`; any
   mandatory failure → `DISTRIBUTION_FAILED`, rerunnable (only the failed artifacts).
8. A `billrun_view` user can follow all of the above read-only, with no mutating
   action visible.

## Architecture & boundaries

- **Workflow engine.** Two Kestra executions per run — `bill_run_processing` and
  `bill_run_distribution` — deployed to the `billrun` namespace on a shared
  `workflow-engine` Container App (collapsed topology; the rating flows share it).
  The app triggers/reconciles/cancels via an out-of-band `billrun-engine-auth`
  credential; the flows call back over M2M (bearer `BILLRUN_APP_TOKEN`).
- **Two-writer charge boundary (Postgres grants).** `billrun_runtime` writes the
  bill data (`customer_bill` trial columns, `customer_bill_line`,
  `customer_bill_tax_item`) and holds `SELECT`+`UPDATE` on only the six
  `rating.udr_rated` claim columns; it holds **no** table-level `DELETE` on
  `customer_bill_line` (the scoped `SECURITY DEFINER billrun_delete_trial_bill` is
  the only deletion path) and no write on run-state tables, `billing.document`,
  pgledger or `bill_run_invoices`. The **app** holds `SELECT`-only on
  `customer_bill_line`; its only `rating` write is the six claim columns via
  `db/repositories/billing/udr-status.repository.ts`. Role-aware triggers
  (`billrun_status_guard`, `rating_status_guard`) enforce the allowed transitions
  at the database. No cross-schema foreign keys in either direction.
- **Charge model.** `customer_bill_line` is the bill's durable stored charge record
  (the invoice's face), partitioned like `customer_bill`, `ON DELETE CASCADE` to its
  header. `charge_checksum` is re-anchored on `customer_bill_line`, hashing business
  content (all three money columns) so it covers every charge source and reproduces
  from an archived invoice; it is computed once at posting (no post-posting
  re-verification — a tracked residual).
- **Idempotency & signals.** Enforced solely by the DB unique constraint
  `(run, ban, stage, attempt, period_partition)` on `bill_run_account_stage` — a
  replayed signal is a 200 no-op; a signal after `APPROVED` is 409. The M2M
  completion call carries no charge payload; the app records what it is told and
  computes nothing (record-only; `TERMINAL_STAGE='verification'` flips the account to
  `PROCESSED`).
- **Retention & immutability.** Per-run record tables are partitioned on
  `period_partition` (monthly, 7-year detach-and-archive via `pg_partman`/`pg_cron`).
  Once `APPROVED`, the run's charge records are immutable for the invoice's statutory
  life (Inv. #14); a finalized `customer_bill` (carrying `ref_inv_document_id`) is
  DB-guarded against mutation/delete; `bill_run_invoices` rows are born immutable.

## In scope

- The "Billing" section: Bill Runs list (Current & Upcoming / Historical) and the run
  detail page (Workflow, Customers & Bills, Uncharged, Errors, Distribution, Audit),
  the approve/post views, and the PRO-FORMA / stored-invoice preview modals.
- `billing` schema tables: `bill_run`, `bill_run_account`, `bill_run_account_stage`,
  `customer_bill`, `customer_bill_line` (incl. the capacity `rated_amount` and
  `additional_info` columns, `0044`), `customer_bill_tax_item`,
  `bill_run_invoices`, `bill_run_distribution`, `bill_format`,
  `bill_template_version`, `bill_asset`, `bill_asset_version` — partitioned
  where per-run.
- Target-capacity pricing (commitment floor + motivation discount, six HARD
  guards, Model-2 verification) for RAN_USAGE capacity offerings — see the
  Target Capacity Pricing update section.
- The real `bill_run_processing` flow (validation, correlation-based collection,
  two-source aggregation, taxation, verification) and the real `bill_run_distribution`
  flow (blob download → SFTP upload → outcome POST, multi-target).
- Recurring charge derivation from `inventory.product_inventory` with as-of pricing +
  snapshot; the `billrun_runtime`/`app_runtime` grants and the two status-guard
  triggers.
- Additive Accounts-owned objects: `document_inv_seq`, `'INV'` document type, the
  unlimited-`autoPostLimit` INV reason code, GL mapping rows, and the period-close
  guard.
- Route handlers under `app/api/billrun/` (stage-complete, status,
  distribution/outcome — service-token authed) and server actions (trigger, rerun,
  cancel, reject, approve, post). Materialization is the write on the list page's
  server render, not an action.
- RBAC: `billrun_view` / `billrun_operate` / `billrun_approve` (operate & approve
  imply view), the Billing Viewer role, and four-eyes in the service layer.
- The `RAN_USAGE` sample seed (`ci` + `volume` profiles, six scenarios) and the
  vitest suites plus the end-to-end journey.

## Out of scope / interim decisions

- **Real taxation** — ratified `0.00` interim; `total = subtotal`. Single-rate
  `BILLRUN_TAX_RATE` config exists; no jurisdiction/category catalog.
- **OCC (one-time / multi-cycle) charges and discounts** — `source`/`line_type`
  reserved; no occurrence ledger, no discount compute. Manual DBN/ADJ/CRN via
  Accounts → Transactions.
- **Proration** — a partial-period account (mid-period start/cease/suspend) is
  `EXCLUDED` before the flow runs and bills from the next full cycle; excluded
  accounts/subscriptions appear on Uncharged. For capacity offerings this is the
  open business decision **O-TC7**.
- **Off-cycle / on-demand runs, multi-frequency cycles, scheduled (cron) creation,
  per-invoice approval, TMF REST surface** — modelled or deferred, not built.
- **Distribution targets beyond SFTP + loopback**, a stored `bill_run_output`
  report, and **Kestra Enterprise / scoped per-flow tokens** — deferred.
- **Production cutover** — the deploy path was made deployable + wired in
  Phase 4 (bm38, `815a3ae`); the live cloud run is a gated ops step, not part of the module build.

## Phase 4 — signal-back, self-driving lifecycle & production wiring (delivered, bm36–bm39)

_Folded from the former Phase-4 update overview (2026-09-16). Users: RevOps (in-app) and BSS Ops (Kestra engine + deploy layer). Phase 4 introduced **no new database schema or migrations** — its surface was flow YAML + bicep + Key Vault secrets + a smoke test._

Phases 1–3 built the whole machinery, but a triggered run could not finish on its own: the processing flow's signal-back was stubbed (`bill_run_processing.yml` carried `io.kestra.plugin.core.log.Log` placeholders, zero `http.Request` tasks), so accounts never auto-reached `PROCESSED` and the run wedged in `PROCESSING`. Phase 4 wired that signal-back (success **and** terminal failure), proved the full `SCHEDULED → COMPLETED` lifecycle locally on the `ci` seed, and made the production deploy path deployable-and-wired — the cloud cutover left as a gated ops step.

- **Processor signal-back (bm36 — the unblocker).** After each stage's SQL the flow POSTs a per-stage `DONE` to `/api/billrun/{runId}/stage/{stage}/complete` (`Authorization: Bearer {{ secret('BILLRUN_APP_TOKEN') }}`, body `{ban_id, attempt, status: DONE|FAILED, error_class?, error_code?, error_detail?}`, no charge payload — the receiver stays record-only). Real `errors: on_error` (terminal `FAILED`) and `afterExecution`/`on_finally` (terminal `/status` only for a `KILLED` whole-execution failure) POSTs replace the `Log` stubs, with `attempt`-guarded idempotency, retry/`allowFailure`, and `host.docker.internal` reachability — mirroring bm34's distributor callbacks verbatim.
- **Failure model.** A contained **per-account** HARD failure is a `WARNING` execution: the account settles to `PROCESSING_FAILED` via its own `FAILED` stage POST while the run derives `PROCESSED` (a mixed terminal set), with the failed account `SKIPPED` at approval and the run rerunnable. A **whole-execution** failure (`FAILED` via `on_error`, or a KILL via `afterExecution: on_killed`) settles the run itself to `PROCESSING_FAILED` — no run-level terminal push for a partial run.
- **End-to-end assertion + reconcile alignment (bm37).** `scripts/billrun-live-kestra-smoke.ts` drives and asserts the full `SCHEDULED → COMPLETED` journey on the `ci` seed — including reject → re-rate → reprocess, a forced processing failure that settles, and distribution with a forced mandatory failure → `DISTRIBUTION_FAILED` → rerun — and confirms the stall/reconcile gate no longer fires on a healthy run while still catching a wedged one (closing the bm16/bm20 live-Kestra gate locally).
- **Production wiring (bm38 — deployable, gated).** Key Vault secrets + consumer mapping into the shared `workflow-engine` Container App bicep: the `billrun_runtime` DB credential as the `billrun-runtime-db-password` bare-password secret + the `BILLRUN_DB_*` split coords the flow actually reads (**not** the superseded `BILLRUN_RUNTIME_DATABASE_URL` URL), plus `billrun-engine-auth`/`-url` and the SFTP key/known-hosts, and the `billrun_runtime` password provisioning step. No new container — the collapsed-topology shared engine already hosts the `billrun` namespace and the `local-dev` flow is promoted as the production flow. Deploy flags (`deployWorkflowEngine`, `deployRatingFlows`, the billrun flow deploy, `runBillrunLiveKestraSmoke`) are readied but gated; the `template.yml` "separate repo, TBD owner" fiction is corrected; the taxation-`0.00` interim and the cutover runbook are recorded.
- **Phase-4 exit (bm39).** The assembled phase was audited and signed off — signal-back incl. `FAILED` settlement, the reject/reprocess and distribution paths, and the prod-wiring artifacts all present and green; the full local journey run as the phase proof; no new schema/migration; `billmgmt-progress-tracker.md` updated and `billmgmt-known-issues.md` §9 closed. **The remaining item is the cloud cutover** — flip the gated flags and run the smoke against a real engine + SFTP — a gated ops step, not a module-build gap.

## Target Capacity Pricing update — commitment floor, motivation discount & usage appendix (delivered, bm40–bm46)

_Folded from `billmgmt-update-overview.md` Part 1 (2026-10-04) per the bm46 ship gate; **fully rolled up 2026-10-15** (overview, goals, flow, features, scope and success criteria moved here, corrected against dev1, and the Part 1 body removed from the update overview). Users: Revenue Operations (RevOps, in-app) and BSS Ops (Kestra engine). Source plan: `_updatemodule-billing-billrun-target-capacity-plan.md`. Invariants: `billmgmt-architecture.md` Inv #29–#38. Per-unit detail: `specs/bm40`–`bm46`; history: `billmgmt-progress-tracker.md`._

Phases 1–4 billed usage and recurring charges at a flat per-unit rate. This update adds **target-capacity pricing** for RAN_USAGE offerings — a **commitment floor** (an account using less than its committed quantity is billed as if it used the target) and a **motivation discount** (usage above the target is billed at a lower per-unit rate, recorded as a discount) — computed as inline SQL in the existing `bill_run_processing` flow, plus a **per-polygon invoice usage appendix** grouped by state and district. A prerequisite repair (Unit 0) first fixed the recurring resolver, which a product change (PC14) had broken for every account by reshaping `product_offering_price` into one-row-per-component.

- **Unit 0 — foundation repair (bm40).** The recurring resolver repaired onto the PC14 component schema; the hand-copied flow-double test replaced by a harness that extracts and runs the real `bill_run_processing.yml` SQL; a fail-closed destructive-DB preflight added (and the cross-cluster `DROP DATABASE … WITH (FORCE)` removed).
- **Schema (bm41).** `customer_bill_line` gains `rated_amount numeric(18,2)` (NULL for RECURRING; = `gross_amount` on non-capacity USAGE) and `additional_info jsonb` (capacity lines only) — migration `0044`, the update's only migration — plus the three `billrun_runtime` read grants the capacity logic needs (`product_specifications`, `ratecard_ran_usage_lkp`, `ratecard_version`).
- **Capacity aggregation (bm42).** The commitment floor + N-band motivation discount as inline SQL CTEs in `aggregation`, keyed off the subscription's pinned offering version; six HARD guards (`CAPACITY_MULTIPLE_SUBSCRIPTIONS`, `_BASE_RATE_NOT_FOUND`, `_UDR_TYPE_MISMATCH`, `_RATE_MISMATCH`, `_MULTI_STEP_UNSUPPORTED`, `_CURRENCY_MISMATCH`) each fail only their own account while siblings bill; the `additional_info` calc trace; the `capacity_max_bands` single-band production guard.
- **Verification + the rate-matching gate (bm43).** USAGE lines replay against `rated_amount` (not `gross_amount`, which the top-up inflates); capacity lines replay their internal identities; an independent Model-2 cross-derivation (`max(Q, target) × baseRate`) checks Model 1 (the billed figure) without ever billing from it; the `capacity_rate_matching` gate (default ON) HARD-fails a mismatch; OFF logs a per-account `RAISE NOTICE` and bills Model 1 anyway (the flag state is not persisted on the run or bill).
- **Checksum + read model (bm44).** `charge_checksum` appends `rated_amount` as its last tuple element (never hashing `additional_info`); the bill-line read model surfaces `rated_amount`/`additional_info`; the Customers & Bills discount column un-suppresses for a capacity line's real discount.
- **Invoice usage appendix (bm45).** The posted invoice (final only, never the draft PRO-FORMA) renders every polygon's usage for the month below the capacity charge, grouped by state then district, with state/district joined from the `productCardLookUp` ratecard; bounded to ≤10,000 rows/account; a card-missing polygon is surfaced, not dropped. **Superseded by bm47 (Invoice Template update) — see below:** the binder has one input for both render modes, so this section (now the layout's `usageAnnex`) renders on the draft PRO-FORMA preview too; "final only" was a property of the legacy hardcoded template, not a durable rule. **Geo source superseded by bm48/bm49:** rating now writes `state`/`district` onto `udr_rated` (migration `0045`) and the annex reads them from the claimed rows (`rated-lines.repository.ts`; unmatched rows group under "Unassigned region"), with no ratecard query at render. The flow still writes the bm45 ratecard-joined snapshot (`_bm45_volume` → `additional_info.appendix`), but nothing renders it.
- **Ship gate (bm46).** Audited the assembled update against guardrails 36–42 and invariants #29–#38; confirmed no migration beyond `0044`; synced this overview, `billmgmt-architecture.md`, `billmgmt-code-standards.md`, `billmgmt-known-issues.md` (the bm45 D2/D4 residuals, the TC40/TC55 rounding-drift residual, and O-TC7) and `billmgmt-progress-tracker.md`. **The live-Kestra capacity journey (TC54) remains outstanding** — no capacity-aware harness exists (`scripts/billrun-live-kestra-smoke.ts` is `ci`-profile only); see `billmgmt-progress-tracker.md`. _(Updated 2026-10-12, verified against dev1 `614743a`: the DB-gated capacity suites, also listed as outstanding at bm46, have since run green — bm42a integration 1165/0, bm63 integration 1219/0.)_ **O-TC7 (partial-period capacity billing) is an open business decision** — partial-period capacity accounts stay `EXCLUDED` until business settles whether/how to pro-rate.
- **Flow aggregation + verification fixes (bm42a, `3477621`, review fixes `4590498`).** Three billing-flow defects found by the full DB-backed runs (known-issues §21 21c2–21c4) fixed in `bill_run_processing.yml`: `band_no` computed outside `jsonb_agg`, string money in the calc trace, and three extra plain-USAGE predicates in verification (incl. `discount_amount IS DISTINCT FROM 0`). Product unit pm46a (migration `0049`) also changed this flow: `_bm29_resolved` reads only the recurring `flat_fee` lane and `RECURRING_PRICE_UNSUPPORTED` is retired.

**Status (2026-10-15).** Delivered. bm46's open items (2) DB-gated capacity suites and (3) the 5 unconfirmed vitest failures are **closed** by later green runs (bm42a integration 1165/0, bm63 integration 1219/0). **Still open:** (1) **TC54**, the capacity-aware live-Kestra harness (success criterion 7), and **O-TC7**, partial-period capacity billing (a business decision).

### Overview

The module runs monthly bill runs for RevOps: it materialises a `bill_run` per cycle, claims each account's already-rated usage from `rating.udr_rated`, derives recurring charges from `inventory.product_inventory`, assembles `customer_bill` + `customer_bill_line`, approves under a four-eyes gate, posts one `INV` per account into pgledger through the Accounts engine, renders and stores the invoice PDF, and distributes invoices plus the run report over SFTP. This update added **target-capacity pricing** for RAN_USAGE offerings:
- a **commitment floor**: an account that uses less than its committed quantity is billed as if it used the target;
- a **motivation discount**: usage above a step threshold is billed at a lower per-unit rate, and the difference is recorded as a discount.

Both are applied after aggregation, at billing-account level, as inline SQL in the existing `bill_run_processing` flow. Because product change PC14 had reshaped `product_offering_price` into one row per component, the recurring resolver had stopped matching the schema and failed every account; Unit 0 repaired that first (a live P0) before any capacity logic landed. The update depended on `_change-rating-configuration-plan.md` (PER_UNIT rating, the `udr_subscription_ref_id` rename, the real subscriber resolver), which has shipped. The per-polygon invoice appendix it also added has since been superseded by the Invoice Template update's usage annex (see bm45 above).

### Goals

1. **Repair the bill run onto the component price model (Unit 0, live P0).** Rewrite the bm29 RECURRING resolver off the removed `pop.amount`/`pricing_model`/`price_type` columns onto `component_type` + `price_component jsonb`; one shared as-of component reader partitioned by `(product_offering_id, component_type, unit_of_measure)`; remove the dead tiered branch; replace the hand-copied test double with a harness that runs the flow's real SQL. Shipped as its own PR, deployed first.
2. **Apply the commitment floor.** For a capacity offering, bill `max(Q, target) × baseRate`: a top-up of `(target − Q) × baseRate` fills the gap to the committed quantity, even at zero usage.
3. **Apply the motivation discount.** Bill usage above the step threshold at the lower step rate; record the saving as `discount_amount = Σ bandQty × (baseRate − stepRate)`, with `gross` at the base rate and `net = gross − discount`.
4. **Compute in one transaction, verified independently.** All capacity logic is inline SQL CTEs in the psql `aggregation` step, in the same whole-account-replace transaction that writes the bill (Model 1, anchored on `Σ udr_rated_price`). Verification carries an independent volume-based cross-derivation (Model 2, `max(Q, target) × baseRate`), gated by the `capacity_rate_matching` flow input.
5. **Guard every misconfiguration as a loud, account-level HARD failure.** Six codes fail only their own account (`PROCESSING_FAILED`, skippable/rerunnable) while sibling accounts keep billing.
6. **Extend verification and the posting checksum, and store a calculation trace.** Reconcile each USAGE line against `rated_amount`; append `rated_amount` to the `charge_checksum` tuple; write an `additional_info` calc trace on every capacity line.
7. **Render per-polygon usage on the invoice.** _Delivered by bm45, then superseded by bm47–bm49 (the usage annex reads geo from `udr_rated`)._
8. **Keep multi-step motivation roadmap-ready.** The SQL and tests are N-band; the `capacity_max_bands` flow input (default 1) blocks more than one band in production, so multi-step is later a config change, not a pricing-SQL edit.

### Core user flow (changes to the module flow above)

Materialise, Trigger, Distribute and Complete are unchanged.

1. **Collection.** Per account, the flow claims the account's `RAN_USAGE` rows `RATED → BILL_DRAFT`, correlating each via `udr_subscription_ref_id = product_inventory_id → billing_account_id`.
2. **Aggregation: capacity pricing.** For an account holding a capacity offering (detected by a `capacity_commitment` and/or `capacity_motivation` component, never by a column):
   - resolve the base `usage_rate`, `capacity_commitment` and `capacity_motivation` components off the subscription's **pinned** offering version (via `product_inventory → order_item`, the same version rating priced from);
   - compute `rated_amount = Σ udr_rated_price`, `topUp = round(max(target − Q, 0) × baseRate, 2)`, `gross = rated_amount + topUp`, `discount = Σ round(bandQty × (baseRate − stepRate), 2)`, `net = gross − discount`;
   - write one `customer_bill_line` per `(offering, unit_of_measure)`: `source 'USAGE'`, `udr_type` = the offering's spec `udrType`, `grouping_key <offering>:CAPACITY:<unit>`, generated from the active subscription even at zero usage, carrying the money columns, `rated_amount`, `discount_rate`/`discount_amount_raw` and the `additional_info` calc trace; `quantity` is the actual metered Q;
   - a misconfigured account HARD-fails one of the six guards and settles to `PROCESSING_FAILED`; every other account keeps processing.
3. **Verification.** Each USAGE line replays `SUM(udr_rated_price) = rated_amount`; each capacity line is checked for `gross = rated_amount + topUp` and `net = gross − discount`, and reconciled against the independent Model-2 recompute. `capacity_rate_matching` (default ON) HARD-fails a rating-vs-bill-run rate mismatch with a diagnostic naming both rates and both version sources. Set OFF, it downgrades to a logged per-account WARN (`RAISE NOTICE`) and bills Model 1's number; the flag state is **not** persisted on the run or bill.
4. **Review.** Customers & Bills shows the capacity line as the invoice's face, its `udr_rated` rows as per-subscription drill-down, and the motivation discount in the line's discount column (un-suppressed by bm44). The calc trace stays database-only.
5. **Approve → Post → render.** Unchanged, apart from the checksum tuple (bm44). Per-polygon usage renders through the Invoice Template usage annex (bm47–bm49), on both the draft PRO-FORMA and the final invoice.
6. **Partial periods.** An account with a mid-period start, cease or suspension is `EXCLUDED` at scoping and produces no capacity bill that month (its usage stays `RATED`, unclaimed); it resumes at the next full cycle. No proration (O-TC7).

### Features

#### Unit 0: schema repair and test harness (bm40)

- Recurring resolver on `component_type = 'flat_fee' AND price_component->>'priceType' = 'recurring'` and `(price_component #>> '{params,amount}')::numeric`; the shared as-of component reader; the dead tiered branch removed. (pm46a later narrowed `_bm29_resolved` to the recurring `flat_fee` lane only.)
- The hand-copied `tests/db/helpers/billrun-aggregate.ts` double replaced by a harness that parses `bill_run_processing.yml`, strips the Kestra `{{ }}` templating, rebinds the GUCs and runs the real step heredocs in one transaction, so tests cannot drift from the deployed flow.
- A fail-closed destructive-DB preflight (explicit opt-in + a disposable sentinel, run before any DB client import); the cross-cluster `DROP DATABASE … WITH (FORCE)` removed.

#### Capacity aggregation (bm42)

- Commitment floor and motivation discount as inline SQL CTEs in `aggregation`, as `billrun_runtime`, in the per-account whole-account-replace transaction.
- Capacity line identity `(offering, unit_of_measure)`, generated even at zero usage, excluded from the ordinary USAGE rollup by an anti-join so volume is never double-counted. N-band SQL with the single-band `capacity_max_bands` guard.
- Each monetary component rounded once (2 dp, HALF_UP); `gross` and `net` derived from the rounded parts and never re-rounded, so the identities hold with no ±0.01 tolerance on integer anchors (a fractional-usage fixture accepts ≤ 1¢ drift, TC40).

#### Account-level guards (HARD, per account)

- `CAPACITY_MULTIPLE_SUBSCRIPTIONS`: more than one ACTIVE subscription of the same capacity offering on the account.
- `CAPACITY_BASE_RATE_NOT_FOUND`: a modifier present with no same-unit `usage_rate` to price from.
- `CAPACITY_UDR_TYPE_MISMATCH`: a claimed row whose `udr_type` ≠ the spec `udrType`.
- `CAPACITY_RATE_MISMATCH` (G2): a claimed row priced at a rate other than the resolved base rate (`IS DISTINCT FROM`, so a NULL rate counts); governed by `capacity_rate_matching`.
- `CAPACITY_MULTI_STEP_UNSUPPORTED`: a motivation schedule with more bands than `capacity_max_bands`.
- `CAPACITY_CURRENCY_MISMATCH` (G3): the resolved component currency ≠ the account currency.

#### Verification, checksum and calc trace (bm43, bm44)

- USAGE-line replay reconciles against `rated_amount` (not `gross_amount`, which the top-up inflates); capacity lines reconcile their internal identities and the independent Model-2 recompute (target/steps/baseRate re-resolved from the catalog, never read back from `additional_info`). A tamper is caught by both detectors.
- `charge_checksum` **appends** `rated_amount` as the last tuple element, preserving the delivered field order; `additional_info` is never hashed.
- `additional_info` carries `pricing` (the resolved price rows), `calc` (the ordered operations) and a pre-rendered `summary[]`. It is database-only. (It also still carries the bm45 `appendix`, which nothing reads.)

#### Configuration

- `capacity_rate_matching` (flow input, default ON): governs both G2 in aggregation and the Model-2 check in verification. ON hard-fails a mismatch; OFF logs a WARN and bills Model 1.
- `capacity_max_bands` (flow input, default 1): the single-band production guard; raising it enables the already-built N-band path.

#### Data model, access and seeds (bm41)

- `billing.customer_bill_line` gains `rated_amount numeric(18,2)` (NULL for RECURRING; `= gross_amount` on non-capacity USAGE) and `additional_info jsonb` (capacity lines only). Migration `0044`, the update's only migration.
- `billrun_runtime` gains `SELECT` on `product.product_specifications` (the `udrType` characteristic) and, for the bm45 appendix, `product.ratecard_ran_usage_lkp` + `ratecard_version`.
- The `_SAMPLE_` seed carries a fixture per test scenario, including a multi-polygon, multi-state/district capacity account.

### In scope

- Unit 0: the component-model repair, the shared as-of reader, the dead-branch removal, the extracted-SQL test harness and the destructive-DB preflight.
- Capacity aggregation: commitment floor + motivation discount as inline SQL; the capacity line at `(offering, unit)`, generated even at zero usage; N-band SQL with the single-band guard.
- The six HARD account-level guards.
- Verification (`rated_amount` replay + Model-2 cross-derivation) and the `charge_checksum` re-anchor appending `rated_amount`.
- The `additional_info` calc trace (database) and the per-polygon invoice appendix (PDF; since superseded by bm47–bm49).
- The two new `customer_bill_line` columns + Drizzle mirror; the `billrun_runtime` grants; the seed fixtures.
- The `capacity_rate_matching` and `capacity_max_bands` flow configuration.

### Out of scope

- **Proration / partial-period billing (O-TC7)**: partial-period accounts stay `EXCLUDED`; whether those months should bill, and how to prorate the floor, is an unresolved **business** decision.
- **Multiple billing accounts per customer for the same capacity product**: one account per product per customer; the rating resolver is customer-grain.
- **Negotiated overrides on capacity offerings**: enforced out by the rate-mismatch guard.
- **Rate-card item pricing**: a card with per-item rates is incompatible with a single base rate; the card is validation/mapping/fields only.
- **Multi-step motivation in production**: built and tested, blocked by `capacity_max_bands`.
- **Any display of the calc trace** (`calc`/`summary`): database-only.
- **Real taxation**: the ratified `0.00` interim stands (`total = subtotal`).
- **The product / inventory / ordering changes** (`max_instances_per_billing_acc`, the `udrType`/`productCardLookUp`/`singleSubInstPerCust` specs, the order-time guard): a separate prerequisite phase.

### Success criteria

1. On the `_SAMPLE_` `ci` seed (base rate 100, committed 1000, motivation > 1000 @ 50, unit EA): usage 800 bills `net 100,000` (rated 80,000 + top-up 20,000); 1000 bills `100,000`; 2000 bills `net 150,000` (gross 200,000 − discount 50,000); 0 bills `100,000` (full floor). `subtotal = SUM(net_amount)`. **Met.**
2. Each of the six guards fails only its own account (`PROCESSING_FAILED`, rerunnable) while siblings bill; a NULL/`ZERO_RATED` rate trips `CAPACITY_RATE_MISMATCH` (proving `IS DISTINCT FROM`). **Met.**
3. On a rating-consistent run the Model-2 cross-derivation reconciles with the stored `gross`/`discount`; a mismatch HARD-fails under `capacity_rate_matching` ON with a diagnostic naming both rates, and under OFF downgrades to a logged WARN and bills Model 1. **Met** (the flag state is not persisted; amended at bm43).
4. Verification catches a tampered `rated_amount`/`gross`/`discount`/`calc.total` via both detectors; every capacity line holds `discount_amount ≥ 0` and `net_amount ≥ 0`. **Met.**
5. The posted invoice renders the per-polygon usage appendix grouped by state and district, load-tested to 10,000 polygon rows per account; a polygon absent from the card is surfaced, not dropped. **Met at bm45; superseded** by the Invoice Template usage annex (criterion 8 of that section).
6. A rerun reproduces identical lines and `line_no` (whole-account replace). **Met.**
7. The deployed, pebble-rendered flow drives a capacity account `SCHEDULED → COMPLETED` on the `ci` seed through a real Kestra execution, and Unit 0's aggregation/recurring/volume/verification/checksum suites pass against the PC14 schema. **OPEN (TC54):** the suites pass, but no capacity-aware live harness exists (`scripts/billrun-live-kestra-smoke.ts` is `ci`-profile only).
8. No migration beyond `0044`; `npm run typecheck`, `npm run lint` and the vitest suite pass; the owning docs are synced. **Met** (the 5 vitest failures recorded at bm46 are closed by later green runs).

## Invoice Template update — company profile, structure-configurable template, binder & CSV (delivered, bm47–bm63)

_Folded from `billmgmt-update-overview.md` Part 2 (2026-10-11) per the bm63 ship gate. Users: Revenue Operations billing admins (in-app, the `invoice_settings` permission) and developers (layout authoring in the repo). Source plan: `_updatemodule-billing-invoice-template-merged-plan.md` (its §15 v1 review, R1–R11, is authoritative). Invariants: `billmgmt-architecture.md` Inv #39–#50. Per-unit detail: `specs/bm47`–`bm63`; history and commits: `billmgmt-progress-tracker.md`._

**Delivered (bm47–bm63).** The invoice is bound to `customer_bill_line` and reconciled before it renders (bm47); rating persists `state`/`district` onto `udr_rated` (bm48) and the usage annex lists every billed row state → district (bm49); the template catalog, the default layout and the default generated/CSV versions are seeded (bm50); the blob store is generalized and the two app containers are declared in bicep (bm51–bm52); renders resolve pinned → ACTIVE → default from checksum-verified blobs (bm53) and posting stamps the four versions (bm54); the Invoice template editor (bm55, bm57, bm58) and the Company profile screen (bm56, bm59–bm61) ship; the CSV export lands (bm62); and the ship gate (bm63) proves criteria 1–12 on a fresh database (the journey) and in the browser (the admin e2e). **Decided at the gate (2026-10-11):** G5 no `ONE_TIME` in v1; G8 IBM Plex embedded (layout v1 carries placeholder font sources, layout v2 ships the real fonts); G9 customer SST/PO/contract fragments hidden, no columns; G16 the app's Managed Identity for blob (a cutover ops step). G14 (no four-eyes on profile activation) was decided the same day. **Residuals:** `billmgmt-known-issues.md` §18–§20 and §23.

### Overview

The Billing Management module runs the monthly bill run for Revenue Operations: it claims rated usage, derives recurring charges, assembles `customer_bill` + `customer_bill_line`, posts one `INV` document per account under a four-eyes gate, renders and stores the invoice PDF in `bill_run_invoices`, and distributes it over SFTP. Before this update the invoice was a hardcoded TypeScript template (`render-invoice-template.ts`) whose renderer read `rating.udr_rated`, so it omitted recurring, one-time and discount charges. The update replaced it with three things: (1) one global, versioned **company profile** (issuer name, SSM no., TIN, SST no., address, bank details, colours, and a required logo) edited under Administration › Invoice Settings; (2) one developer-authored **Handlebars layout** (`INVTPL-STD-A4`) shared by every MNO, where billing admins can only show/hide optional sections and charge-detail columns, each activation generating an immutable `invoice.hbs` + `footer.hbs` version stored write-once in the blob store; and (3) a **binder** that builds the render input from `customer_bill_line`, `customer_bill_tax_item`, `billing.document` and `customer.organization`/`contact_medium`, including a detailed usage section grouped state → district. The template and profile versions used are stamped on the bill at posting, so an issued invoice never changes. Scope is the tax invoice only; outputs are PDF, HTML and CSV.

### Goals

1. **Bind the invoice to the real charge record first (R1, R10).** Re-point the renderer from `rating.udr_rated` to `customer_bill_line` (every `ChargeSource`: RECURRING, USAGE, OCC; no `ONE_TIME` in v1 — C2/G5 decided 2026-10-11, sourcing is a future spec; with discount, offering and net), aggregated on the fly with no new charge-copy table, and prove `Σ net_amount = customer_bill.subtotal` on every rendered invoice before any editor UI is built.
2. **Always have a template (R11).** Seed a developer-authored default layout `INVTPL-STD-A4` and a default generated structure version, flagged `is_default`, always ACTIVE and undeletable. Resolution order is pinned version → current ACTIVE → default, so "no template configured" cannot occur.
3. **Give RevOps one versioned company profile (D5).** Store it as `core.system_config` group `invoice.profile` with DRAFT → ACTIVE → RETIRED versions; activation requires a logo and a change note.
4. **Let billing admins control structure, not layout (D3, D4, R7).** Admins tick optional sections and charge-detail columns on or off; developers own section order, positions, page size, margins, fonts, labels and CSS.
5. **Freeze what was issued (D8).** At posting, record on the bill the generated template version, the company profile version and the CSV template version. Reprint downloads the stored PDF; reproducibility is checked with the existing `customer_bill.charge_checksum`, not a re-render.
6. **Fail loudly, never silently (R8).** A render or validation failure parks that account in the run's exception surface. The legacy `udr_rated` template is never used as a fallback.
7. **Show detailed usage by region (R9).** List every billed `udr_rated` row in a usage section subsectioned state → district, reading geo that rating persisted onto `udr_rated`.
8. **Keep admin input and stored files tamper-proof.** Handlebars auto-escaping with `knownHelpersOnly`, checksums verified at render for templates and logo, sanitized SVG uploads, append-only versions, audit-logged saves and activations.

### Core user flow

1. **Seed (developer, once).** The migration creates `billing.bill_format` (one row, `INVOICE`), layout `INVTPL-STD-A4` v1 (`manifest.json`, `shell.hbs`, `footer.hbs`, `partials/*.hbs`, `sample-data.json`) and the default generated version (`is_default = true`, ACTIVE). On first setup the current `/brand/logo.svg` can be imported as the initial logo artifact.
2. **Maintain the company profile (billing admin, `invoice_settings` EDIT).** Open Administration › Invoice Settings › **Company profile**:
   - edit company details, payment details, brand/accent colours and default payment terms;
   - upload the logo (PNG/JPEG/SVG, ≤ 500 KB, ≥ 300 px; MIME checked against magic bytes; an SVG with scripts, event handlers, `<foreignObject>` or external references is rejected, never repaired; ≤ 2,000 px on either side), stored as a `bill_asset_version`;
   - preview, then **Activate** with a change note. Activation is blocked without a logo. The new version becomes ACTIVE, the previous one RETIRED.
3. **Choose what the invoice shows (billing admin).** Open Administration › Invoice Settings › **Invoice template**:
   - tick optional sections (Payment information, Usage annex, Notes & terms) and optional columns (Service period, Discount, Product offering ID, UDR type & count); mandatory sections are locked on;
   - check the live preview, rendered through the real pipeline (`isDraft: true`) against the layout's sample bill or a recent posted bill (a posted bill is previewed with **its own pinned versions**, not the current ACTIVE);
   - **Save draft** (never used for invoices) or **Activate** with a change note. Activation validates mandatory sections, generates `invoice.hbs` + `footer.hbs`, test-renders against the sample bill, writes the files with checksums to the content-addressed `invoice-templates/generated/INVOICE/v{n}-{digest12}/`, sets the new version ACTIVE and the previous one RETIRED.
4. **Rate usage (rating module, cross-module change).** RAN-usage rating, which already reads the `ratecard_ran_usage_lkp` row for `rate_per_unit`, also writes that row's `state` and `district` onto the `udr_rated` row. Forward-only; no backfill.
5. **Process and review the bill run (unchanged).** The draft (pro-forma) preview resolves the current ACTIVE generated version + ACTIVE profile, shows the `position:fixed` draft watermark, and persists nothing.
6. **Approve → Post.** A second `billrun_approve` user approves. `services/billing/post-run.ts` posts the `INV`, computes `charge_checksum` as today, and stamps `customer_bill.ref_bill_format_id = INVOICE`, `ref_bill_template_version_id` (the generated version, which pins its layout version), `ref_invoice_profile_version` and the CSV template version.
7. **Render the final invoice.** `resolveTemplate` takes the stamped versions → the blob is loaded and its checksum verified → `Handlebars.compile` (cached per version id) → `bind()` merges profile, logo data URI, bill lines, tax items, customer identity, INV number and usage rows → Playwright/Chromium renders the PDF with a "Page X of Y" footer → the PDF is stored once in `bill_run_invoices`. A failure parks the account and shows it in the run's exception surface; other accounts continue.
8. **Distribute (unchanged).** Kestra execution #2 SFTPs the stored PDF.
9. **Reprint and audit.** Reprint downloads the stored PDF. The **Version history** tab on both screens lists every version with status, author, created/activated/retired dates, change note, "used by N invoices", a read-only preview and a `.hbs` download.

### Features

#### Company profile

- Fields: legal name, SSM reg. no., TIN, SST no., address lines, postcode, city, state (MyInvois code 01–16), country, phone, email, website; bank name, account name, account no., SWIFT, JomPAY biller code, remittance email; brand and accent colours (`#RRGGBB`); default payment terms (days, used when the billing account has no override).
- Validation per the placeholder catalog (TIN, SST, postcode, SWIFT, email, colour format); blank optional fields are hidden on the invoice.
- Logo required to activate; the profile version pins a specific logo asset version.
- The application logo (`system_config` `app`/`app_logo_path`, `getBrandingLogo()`) is unchanged and separate from the invoice logo.

#### Invoice template editor

- Mandatory, locked sections: Header (issuer, logo, title), Invoice identification, Bill-to, Amount due, Summary of charges, Tax summary, Charge details, Page footer.
- Optional sections an admin can hide: Payment information, Usage annex, Notes & terms. (Account summary is dropped from v1, R2.)
- Fixed charge-detail columns: #, Description, Quantity, Unit price, Gross, Net amount. Hideable: Service period, Discount, Product offering ID, UDR type & count. (No per-line tax column, R6.)
- Positions never move: hiding a section closes the gap; a half-width section whose partner is hidden widens to full width.
- Live preview with "show placeholders" and outline toggles; read-only **Generated .hbs** tab; **Version history** tab.

#### Template engine

- Handlebars 4.7 added as a direct dependency.
- Data placeholders: `{{company.*}}`, `{{payment.*}}`, `{{invoice.*}}`, `{{customer.*}}`, `{{totals.*}}`, `{{#each lineGroups}}`.
- Helpers: `money`, `date`, `period`, `qty`, `price`, `int`, `amt`, `unitCode`, `asset`, wrapping the existing `formatCurrency` / `formatCalendarDate`.
- Generation-time directives in the developer layout: `[[if sections.<key>]]`, `[[if columns.<key>]]`, `[[num …]]` (derived `colspan`), `[[body]]`. Generated files contain only `{{ }}` placeholders, so the stored file is exactly what was rendered.

#### Render binder and pipeline

- `render-invoice-template.ts` becomes the binder: `resolveTemplate` → `load` (checksum, compile, cache) → `bind` → `renderPdfFromHtml`.
- Render input from `customer_bill_line`, `customer_bill_tax_item` (bill-level tax summary), `billing.document` (INV anchor), `customer.organization` + `contact_medium` (tax identity and address).
- "Amount due" = this invoice's current charges only, and the template states it.
- PDF: A4 page setup from the layout, Chromium `displayHeaderFooter` used only for "Page X of Y", `position:fixed` draft watermark kept (R5); existing semaphore, concurrency cap and close-timeout unchanged.
- Logo fetched, checksum-verified and inlined as a data URI; no external URLs.

#### Detailed usage section

- Every billed `udr_rated` row for the account, grouped state → district, with per-district and per-state subtotals.
- Geo read directly off the claimed `udr_rated` rows; no render-time ratecard lookup and no ratecard version pinning.
- Expected volume a few hundred rows (~6–10 pages) per account, bounded to 10,000 rows; over the bound the account parks with `INVOICE_USAGE_OVER_LIMIT` (G2).

#### Storage, versioning and data model

- `billing.bill_template_version`: immutable, append-only; `kind` = `layout` | `generated` | `csv` (no `xml` in v1); one non-default ACTIVE per (`ref_bill_format_id`, `kind`) beside the always-ACTIVE default (X3); `structure` jsonb (sections, columns), `page_setup` jsonb, `blob_ref`, `checksum`, author/activation/retirement stamps, `change_note`.
- `billing.bill_asset` / `bill_asset_version`: logo artifact (`kind = logo`), retire-only.
- New bill columns: `ref_invoice_profile_version` and `ref_csv_template_version_id` (G12); the reserved `ref_bill_format_id` and `ref_bill_template_version_id` are populated. All four are stamped by `stampPosted` in the posting `UPDATE` (bm54); bills posted earlier keep `NULL` and render with the default.
- Blob store generalized to `putObject/getObject(container, path, bytes, contentType, {writeOnce})`; `putInvoice` refactored onto it (R4).

#### Output formats

- PDF (legal copy, stored write-once) and HTML (preview, email body) from the generated `.hbs`; admin structure options apply.
- CSV from the bill's stamped, checksum-verified column map (`GET …/stored-invoice/[banId]/csv`, `billrun_view` READ, bm62): one row per line item, formula-safe cells, and the `net_amount` column sums exactly to the bill. The customer's name and TIN are read live, so a CSV downloaded after a customer rename shows the new values (accepted, known-issues §23j).

#### Security, access and audit

- Auto-escaping on; triple-stash forbidden; `knownHelpersOnly`; no eval-style helpers.
- CI layout lint: no raw `<img src>` or external URLs; images only via `{{company.logoUrl}}` / `{{asset}}`.
- New permission `invoice_settings` (READ / EDIT) guards both screens; every save and activation writes `AUDIT_LOG`.
- Checksum mismatch on a template or logo fails the render.

### In scope

- Binder over `customer_bill_line` + `customer_bill_tax_item` + `billing.document` + `organization`/`contact_medium`, with the `Σ net_amount = subtotal` reconciliation (built and verified first).
- Seeded default layout `INVTPL-STD-A4` + default generated version (`is_default`), and the pinned → ACTIVE → default resolution.
- Company profile screen, validation, logo upload as a versioned artifact, activation with change note, version history.
- Invoice template editor: section and column show/hide, live preview, save draft, activate, Generated .hbs tab, version history.
- Handlebars engine, helpers, generation-time directives, generator.
- Tables `bill_format`, `bill_template_version`, `bill_asset`, `bill_asset_version`; the new bill version columns; stamping in `post-run.ts`.
- Generalized blob store and `putInvoice` refactor.
- Detailed usage section by state → district, plus the rating-side change that writes `state`/`district` onto `udr_rated`.
- PDF, HTML and CSV outputs; "Page X of Y" footer.
- Park-on-failure handling in the run exception surface.
- `invoice_settings` permission, audit logging, SVG sanitizer, layout lint.
- Unit, golden-render, multi-page, pinning, tamper, fresh-database journey and browser e2e tests.

### Out of scope

- Credit notes, debit notes, and a separate pro-forma document type (pro-forma = draft render) (D1).
- Per-MNO or per-customer templates and MNO assignment (D2).
- Admin control of section order or position, labels, wording, colours within the template, image slots, page setup or fonts (D3, D4).
- An admin code editor and a drag-and-drop designer.
- Multi-brand / multi-entity issuing.
- Account summary / balance brought forward (R2) — revisit with the payments/credit-note ledger.
- MyInvois UBL XML, the MyInvois submission/validation module, all `einvoice.*` fields, the classification code and state-code mapping (R3); no `kind = xml`, `system/xml` paths or sample XML.
- Per-line tax and SST tax-invoice compliance (R6); real taxation (the ratified `0.00` interim stays).
- Shared asset library (signatures, stamps, letterheads, banners) and generated DuitNow QR codes.
- Bilingual BM/EN invoices.
- Re-rendering for reprint, and any fallback to the legacy `udr_rated` template.
- Backfilling `state`/`district` onto `udr_rated` rows rated before the rating change.

### Success criteria

1. On the `ci` seed, every posted invoice's charge details include all of its `customer_bill_line` rows (RECURRING, USAGE, OCC; no ONE_TIME in v1, G5) and discounts, and `Σ net_amount` on the invoice equals `customer_bill.subtotal`. _Evidence: journey step 2 (`tests/e2e/invoice-template-journey.integration.test.ts`); `bind.test.ts` reconciliation._
2. On a fresh database, `bill_format` has exactly one row (`INVOICE`), and `INVTPL-STD-A4` v1 plus the default generated version are ACTIVE with `is_default = true`; the default cannot be deleted or retired, and a bill run posted with no admin activity renders with it. _Evidence: journey step 1; `tests/guardrails/invoice-default-resolution.integration.test.ts` (45); `tests/db/invoice-template-catalog.integration.test.ts`._
3. The company profile cannot be activated without a logo or without a change note; invalid TIN, SST, postcode, SWIFT, email or colour values are rejected; a logo over 500 KB, under 300 px, with a MIME/magic-byte mismatch, or an SVG containing `<script>` is rejected. _Evidence: admin e2e profile scenario (`tests/e2e/invoice-settings-admin.e2e.integration.test.ts`); `tests/db/activate-profile.integration.test.ts` (51); `upload-logo.test.ts` (52)._
4. In the template editor, mandatory sections cannot be unticked; hiding Discount removes the column and its total from the preview; activating creates version n+1 as ACTIVE and n as RETIRED, listed in Version history with author, dates and change note; the generated `.hbs` contains no markup for hidden sections or columns and no `[[ ]]` directives. _Evidence: admin e2e template scenario; `generate.test.ts` (48); `tests/db/activate-template.integration.test.ts` (53)._
5. After an invoice is posted under generated v2 and profile v1, activating v3 and profile v2 leaves that bill's recorded versions and stored PDF unchanged, while a new draft preview uses v3 and profile v2. _Evidence: journey step 4; `tests/guardrails/invoice-version-pinning.integration.test.ts` (46)._
6. Changing one byte of a stored template or logo blob makes its render fail the checksum check: that account is parked and appears in the run's exception surface, other accounts post, and no invoice is rendered with the legacy template. _Evidence: journey step 5; `tests/guardrails/invoice-checksum-tamper.integration.test.ts` (47); `invoice-no-legacy-render.test.ts` (44)._
7. A fixture forcing 3+ pages shows "Page X of Y" on every page, repeats the table header, keeps each line group on one page, and the draft watermark is not clipped by the footer margin. _Evidence: journey step 7 (10,000 rows render ≥ 3 pages with the footer, `thead` and line-group rules and the fixed watermark; 10,001 park)._
8. The detailed usage section lists every billed `udr_rated` row under its state and district with correct per-district and per-state subtotals, reading geo from `udr_rated` with no ratecard query at render. _Evidence: journey step 2 ("Unassigned region"); `tests/db/invoice-usage-annex.integration.test.ts`._
9. The CSV has one row per line item and its line amounts sum exactly to the bill. _Evidence: journey step 6; `tests/db/invoice-csv.integration.test.ts` (55)._
10. Reprint returns the stored PDF bytes unchanged, and recomputing `charge_checksum` from the bill's lines matches the stored value. _Evidence: journey step 4 (reprint route bytes, `charge_checksum` recompute); guardrail 46._
11. A user without `invoice_settings` READ cannot open either screen; a READ-only user cannot save or activate; every save and activation writes an `AUDIT_LOG` entry; a customer name containing `<script>` renders escaped. _Evidence: admin e2e (no-access, read-only, escaping with no dialog); journey step 8 (audit rows); `invoice-settings-authz-matrix.test.ts` + `invoice-settings-grants.integration.test.ts` (56)._
12. Golden-render snapshots of each layout version pass in CI; existing bm18/bm19 tests are updated to the new binder and pass; `npm run typecheck`, `npm run lint`, the vitest suite and the browser e2e (the installed `playwright` library, `npm run test:e2e:invoice-settings`) pass; `billmgmt-architecture.md`, `billmgmt-code-standards.md` and `billmgmt-progress-tracker.md` are synced. _Evidence: `tests/services/billing/invoice-golden.test.ts`; `render-invoice-template.test.ts`/`build-invoice-html.test.ts`; `tests/guardrails/invoice-layout-lint.test.ts`; full suites green at bm63._

### Decisions (formerly the open items)

- **X1/C1/G1 = R9** (bm48): rating writes `state`/`district` onto `udr_rated`; Inv #36 amended; G13 reuses PRP's canonical cell match.
- **X2/G2** (bm49): every billed row, 10,000 rows/account; over the bound the account parks with `INVOICE_USAGE_OVER_LIMIT`.
- **X3/C3/G3** (bm50): the one-ACTIVE index excludes the default; resolution is pinned → non-default ACTIVE → default.
- **X4/G4**: carried by the bm47–bm49 binder.
- **O2/C4/G6** (bm50): SHA-256 for template/asset blobs, algorithm recorded per row; invoice PDFs keep md5.
- **O3/G7**: notes & terms and the footer sentence are fixed layout text.
- **O4/G8** (2026-10-11): IBM Plex Sans and Mono embedded; layout v1 has placeholder sources, layout v2 ships the real woff2 data.
- **O5/G9** (2026-10-11): customer SST no., PO and contract references hidden while blank; no columns in v1.
- **C2/G5** (2026-10-11): no `ONE_TIME` charge source in v1.
- **O10/G10** (bm50): nothing deletes a version.
- **G11** (bm50): `invoice_settings` grants ADMIN/MANAGER EDIT, USER READ.
- **G12** (bm50): the CSV version lives on `customer_bill.ref_csv_template_version_id`.
- **G14** (2026-10-11): no four-eyes on profile activation; the bank-change warning and the `bankDetailsChanged` audit flag are the mitigations.
- **G15 = A**: before the first profile activation, invoices render without the issuer and payment blocks and the profile stamp is `NULL`.
- **G16** (2026-10-11): the app's user-assigned Managed Identity with container-scoped `Storage Blob Data Contributor`; the `appBlobAuth` flip is a cloud-cutover ops step.

## Success criteria (module-level)

1. Opening Bill Runs on/after the 1st materialises the prior month's run for every
   active monthly cycle exactly once, concurrency-safe, with no scheduler.
2. A triggered run claims `udr_rated` rows (NULL `billrun_ban_id`), resolves each to
   an account via `product_inventory`, writes real `customer_bill` +
   `customer_bill_line`, and reaches `PROCESSED`; `SUM(net_amount) = subtotal`; an
   account with 3+500 subscriptions of two offerings produces exactly 2 lines.
3. A recurring-only account bills a non-empty, reproducible-checksum bill; an account
   with no charge lines is Uncharged; every `USAGE` line's `gross_amount` equals the
   SUM of the `udr_rated` rows that rolled into it.
4. Reject/rerun release claimed rows to `RATED` (four columns cleared) before
   re-trigger, so no claim survives an abandoned attempt; a rating reload colliding
   with a claimed row is refused (`LOAD_BLOCKED_INFLIGHT` / `LOAD_BLOCKED_BILLED`).
5. A different `billrun_approve` user posts one `INV` per billed account (correct
   `A/R ← revenue` + tax legs, `event_at = gl_event_at`), renders + stores the final
   PDF; a mid-batch `PERIOD_CLOSED` leaves other invoices posted and the run
   resumable; the run reaches `INVOICED` and the next cycle unblocks.
6. Distribution SFTPs each artifact to its own remote path, completes only when every
   mandatory artifact reaches every mandatory target, and reruns only failed
   artifacts on `DISTRIBUTION_FAILED`.
7. A stalled run shows `STALLED` on read; Check status reconciles it, Cancel releases
   it (accounts reset, no numbers consumed). `billrun_view` reaches every read
   surface and no mutation. M2M routes reject a missing/invalid bearer with 401 and
   never log the token.
8. The two-writer grant boundary holds per column/table; `typecheck`, `lint`, and the
   vitest suite pass; the docs conventions and progress tracker are kept current.
9. A freshly triggered run drives itself `SCHEDULED → COMPLETED` with no out-of-band
   calls — real processor signal-back (per-stage `DONE` + terminal `FAILED`
   settlement) makes accounts auto-reach `PROCESSED`, the Workflow timeline fills, and
   Approve appears with no stall banner; post → store → SFTP distribute → `COMPLETED`
   all follow. **Delivered (Phase 4, bm36–bm39):** the signal-back, self-driving
   lifecycle and prod-wiring are built and CI-guarded (the DB-free flow guardrail
   `tests/guardrails/billrun-processing-signal-back.test.ts` and the DB-gated E2E
   double `tests/db/billing-e2e-happy-path.integration.test.ts`, which run on every
   CI). The full live-Kestra `billrun:live-kestra-smoke` run on the `ci` seed is a
   **gated live-stack step** against the provisioned real Postgres/Kestra/blob/SFTP
   stack, and the cloud cutover is a further separate gated ops step.
