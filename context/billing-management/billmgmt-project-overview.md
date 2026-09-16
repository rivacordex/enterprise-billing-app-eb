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
> gated ops step, not a module-build gap (see `billmgmt-update-overview.md`).
> Taxation is a ratified `0.00` interim.

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
