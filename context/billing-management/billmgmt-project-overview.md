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

> **Current state (2026-09-16).** The compute, posting, rendering and distribution
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
> Target Capacity Pricing update section below). **Outstanding for that update:**
> the live-Kestra capacity journey (TC54) and its DB-gated suites have not been
> run against a live Postgres/Kestra stack in this checkout's environment
> (`billmgmt-progress-tracker.md`), and **O-TC7** (partial-period capacity
> billing) remains an open business decision.

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
   - **Collection** resolves each `RAN_USAGE` row `udr_subscriber_ref_id →
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
  `customer_bill`, `customer_bill_line`, `customer_bill_tax_item`,
  `bill_run_invoices`, `bill_run_distribution`, `bill_template_version` — partitioned
  where per-run.
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
  accounts/subscriptions appear on Uncharged.
- **Off-cycle / on-demand runs, multi-frequency cycles, scheduled (cron) creation,
  per-invoice approval, TMF REST surface** — modelled or deferred, not built.
- **Distribution targets beyond SFTP + loopback**, a stored `bill_run_output`
  report, and **Kestra Enterprise / scoped per-flow tokens** — deferred.
- **Production cutover** — the deploy path is being made deployable + wired in
  Phase 4; the live cloud run is a gated ops step, not part of the module build.

## Phase 4 — signal-back, self-driving lifecycle & production wiring (delivered, bm36–bm39)

_Folded from the former Phase-4 update overview (2026-09-16). Users: RevOps (in-app) and BSS Ops (Kestra engine + deploy layer). Phase 4 introduced **no new database schema or migrations** — its surface was flow YAML + bicep + Key Vault secrets + a smoke test._

Phases 1–3 built the whole machinery, but a triggered run could not finish on its own: the processing flow's signal-back was stubbed (`bill_run_processing.yml` carried `io.kestra.plugin.core.log.Log` placeholders, zero `http.Request` tasks), so accounts never auto-reached `PROCESSED` and the run wedged in `PROCESSING`. Phase 4 wired that signal-back (success **and** terminal failure), proved the full `SCHEDULED → COMPLETED` lifecycle locally on the `ci` seed, and made the production deploy path deployable-and-wired — the cloud cutover left as a gated ops step.

- **Processor signal-back (bm36 — the unblocker).** After each stage's SQL the flow POSTs a per-stage `DONE` to `/api/billrun/{runId}/stage/{stage}/complete` (`Authorization: Bearer {{ secret('BILLRUN_APP_TOKEN') }}`, body `{ban_id, attempt, status: DONE|FAILED, error_class?, error_code?, error_detail?}`, no charge payload — the receiver stays record-only). Real `errors: on_error` (terminal `FAILED`) and `afterExecution`/`on_finally` (terminal `/status` only for a `KILLED` whole-execution failure) POSTs replace the `Log` stubs, with `attempt`-guarded idempotency, retry/`allowFailure`, and `host.docker.internal` reachability — mirroring bm34's distributor callbacks verbatim.
- **Failure model.** A contained **per-account** HARD failure is a `WARNING` execution: the account settles to `PROCESSING_FAILED` via its own `FAILED` stage POST while the run derives `PROCESSED` (a mixed terminal set), with the failed account `SKIPPED` at approval and the run rerunnable. A **whole-execution** failure (`FAILED` via `on_error`, or a KILL via `afterExecution: on_killed`) settles the run itself to `PROCESSING_FAILED` — no run-level terminal push for a partial run.
- **End-to-end assertion + reconcile alignment (bm37).** `scripts/billrun-live-kestra-smoke.ts` drives and asserts the full `SCHEDULED → COMPLETED` journey on the `ci` seed — including reject → re-rate → reprocess, a forced processing failure that settles, and distribution with a forced mandatory failure → `DISTRIBUTION_FAILED` → rerun — and confirms the stall/reconcile gate no longer fires on a healthy run while still catching a wedged one (closing the bm16/bm20 live-Kestra gate locally).
- **Production wiring (bm38 — deployable, gated).** Key Vault secrets + consumer mapping into the shared `workflow-engine` Container App bicep: the `billrun_runtime` DB credential as the `billrun-runtime-db-password` bare-password secret + the `BILLRUN_DB_*` split coords the flow actually reads (**not** the superseded `BILLRUN_RUNTIME_DATABASE_URL` URL), plus `billrun-engine-auth`/`-url` and the SFTP key/known-hosts, and the `billrun_runtime` password provisioning step. No new container — the collapsed-topology shared engine already hosts the `billrun` namespace and the `local-dev` flow is promoted as the production flow. Deploy flags (`deployWorkflowEngine`, `deployRatingFlows`, the billrun flow deploy, `runBillrunLiveKestraSmoke`) are readied but gated; the `template.yml` "separate repo, TBD owner" fiction is corrected; the taxation-`0.00` interim and the cutover runbook are recorded.
- **Phase-4 exit (bm39).** The assembled phase was audited and signed off — signal-back incl. `FAILED` settlement, the reject/reprocess and distribution paths, and the prod-wiring artifacts all present and green; the full local journey run as the phase proof; no new schema/migration; `billmgmt-progress-tracker.md` updated and `billmgmt-known-issues.md` §9 closed. **The remaining item is the cloud cutover** — flip the gated flags and run the smoke against a real engine + SFTP — a gated ops step, not a module-build gap.

## Target Capacity Pricing update — commitment floor, motivation discount & usage appendix (delivered, bm40–bm46)

_Folded from `billmgmt-update-overview.md` (2026-10-04) per the bm46 ship gate. Users: Revenue Operations (RevOps, in-app) and BSS Ops (Kestra engine). Full design detail (anchors, guards, verification identities, the N-band SQL, the appendix sourcing) stays in `billmgmt-update-overview.md` and `billmgmt-architecture.md` Inv #29–#38 — this section folds the delivered narrative into the module's current state, per the bm13/bm21/bm35/bm39 ship-gate convention._

Phases 1–4 billed usage and recurring charges at a flat per-unit rate. This update adds **target-capacity pricing** for RAN_USAGE offerings — a **commitment floor** (an account using less than its committed quantity is billed as if it used the target) and a **motivation discount** (usage above the target is billed at a lower per-unit rate, recorded as a discount) — computed as inline SQL in the existing `bill_run_processing` flow, plus a **per-polygon invoice usage appendix** grouped by state and district. A prerequisite repair (Unit 0) first fixed the recurring resolver, which a product change (PC14) had broken for every account by reshaping `product_offering_price` into one-row-per-component.

- **Unit 0 — foundation repair (bm40).** The recurring resolver repaired onto the PC14 component schema; the hand-copied flow-double test replaced by a harness that extracts and runs the real `bill_run_processing.yml` SQL; a fail-closed destructive-DB preflight added (and the cross-cluster `DROP DATABASE … WITH (FORCE)` removed).
- **Schema (bm41).** `customer_bill_line` gains `rated_amount numeric(18,2)` (NULL for RECURRING; = `gross_amount` on non-capacity USAGE) and `additional_info jsonb` (capacity lines only) — migration `0044`, the update's only migration — plus the three `billrun_runtime` read grants the capacity logic needs (`product_specifications`, `ratecard_ran_usage_lkp`, `ratecard_version`).
- **Capacity aggregation (bm42).** The commitment floor + N-band motivation discount as inline SQL CTEs in `aggregation`, keyed off the subscription's pinned offering version; six HARD guards (`CAPACITY_MULTIPLE_SUBSCRIPTIONS`, `_BASE_RATE_NOT_FOUND`, `_UDR_TYPE_MISMATCH`, `_RATE_MISMATCH`, `_MULTI_STEP_UNSUPPORTED`, `_CURRENCY_MISMATCH`) each fail only their own account while siblings bill; the `additional_info` calc trace; the `capacity_max_bands` single-band production guard.
- **Verification + the rate-matching gate (bm43).** USAGE lines replay against `rated_amount` (not `gross_amount`, which the top-up inflates); capacity lines replay their internal identities; an independent Model-2 cross-derivation (`max(Q, target) × baseRate`) checks Model 1 (the billed figure) without ever billing from it; `CAPACITY_RATE_MATCHING` (default ON) HARD-fails a mismatch, OFF logs a WARN and bills Model 1 anyway, recording the flag state.
- **Checksum + read model (bm44).** `charge_checksum` appends `rated_amount` as its last tuple element (never hashing `additional_info`); the bill-line read model surfaces `rated_amount`/`additional_info`; the Customers & Bills discount column un-suppresses for a capacity line's real discount.
- **Invoice usage appendix (bm45).** The posted invoice (final only, never the draft PRO-FORMA) renders every polygon's usage for the month below the capacity charge, grouped by state then district, with state/district joined from the `productCardLookUp` ratecard; bounded to ≤10,000 rows/account; a card-missing polygon is surfaced, not dropped.
- **Ship gate (bm46).** Audited the assembled update against guardrails 36–42 and invariants #29–#38; confirmed no migration beyond `0044`; synced this overview, `billmgmt-architecture.md`, `billmgmt-code-standards.md`, `billmgmt-known-issues.md` (the bm45 D2/D4 residuals, the TC40/TC55 rounding-drift residual, and O-TC7) and `billmgmt-progress-tracker.md`. **The live-Kestra capacity journey (TC54) and the DB-gated capacity suites remain outstanding** — not run against a live Postgres/Kestra stack in this checkout's environment; see `billmgmt-progress-tracker.md`. **O-TC7 (partial-period capacity billing) is an open business decision** — partial-period capacity accounts stay `EXCLUDED` until business settles whether/how to pro-rate.

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
