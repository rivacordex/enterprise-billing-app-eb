# Billing Management Module — Project Overview

## Overview

The Billing Management Module is the section of the Enterprise Billing App (Telco) where the Revenue Operations team executes and controls monthly bill runs. It manages the operational instance of a billing cycle (`bill_run`), the per-account state inside that run (`bill_run_account`, `bill_run_account_stage`), the draft bill assembled for each billing account (`customer_bill`, `customer_bill_tax_item`), and — rather than copying charge lines into billing — a tamper-evident checksum of the posted charges stamped on each bill (`customer_bill.charge_checksum`; the charge records themselves stay in the rating store). The module provides a new "Billing" navigation section whose Bill Runs pages let RevOps see which run is current for each bill cycle, trigger it manually, watch it progress stage by stage, review every customer's draft bill on screen, rerun all or selected accounts while the run is unapproved, and — under a four-eyes gate — approve it, which posts one `INV` document per billed account through the existing Accounts document engine and into pgledger.

**The bill run performs no rating.** Charges are rated continuously by an external rating/charging engine and land as already-rated Usage Detail Records in `rating.udr_rated`; the bill run **collects (claims)** the records due for the period and bills them. The run is orchestrated by a **workflow engine** (fan-out per account, per-stage signals, health/cancel); the workflow engine deployed as part of this solution is **Kestra** (OSS edition), though the schema and app stay vendor-neutral ("workflow" naming). In this release the rating engine is not built — the workflow orchestrates the real pipeline against a **stub** `rating.udr_rated`; the deployment runs in **stub-data mode** (an environment flag) so its figures are clearly badged as fixtures.

## Goals

1. Give Revenue Operations one page that answers "what needs billing right now" — the current run per bill cycle, upcoming runs not yet due, and every historical run — without a calendar or a spreadsheet.
2. Make each monthly run appear automatically on the correct date with **no scheduler, cron job, or background worker in the application**: the run row is materialized on page load from `bill_cycle` and the in-arrears window rule.
3. Track progress at **billing-account grain, not run grain**, so "126 accounts billed, 2 failed" is an ordinary state, and rerunning three accounts is the same operation as rerunning all of them.
4. Let RevOps rerun — fully or for selected accounts — any number of times while the run is unapproved, and make it impossible to rerun anything once an invoice number has been consumed.
5. Enforce four-eyes on the highest-value action in the platform: the user who triggered the final attempt cannot be the user who approves the run.
6. Post invoices through the **existing** Accounts document engine (`INV` documents, `ban.A/R ← revenue` legs, accounting-period validation, pgledger transfers, per-type sequence with configurable prefix/format) so the bill run never grows a second path by which money moves.
7. Make posting resumable per account: a mid-batch failure leaves the other invoices posted and lets the run continue from where it stopped, instead of rolling back 126 invoices.
8. Surface every account and subscription the run deliberately did **not** charge as a visible exception, so unbilled revenue is a work queue rather than a silent omission.
9. Detect a workflow that has gone quiet and give an operator a way out, so one wedged execution cannot block a billing cycle indefinitely.
10. Keep every operator action auditable — trigger, rerun with prior totals and reason, approval, cancellation — in the existing partitioned audit schema.

## Core user flow

The primary flow — RevOps runs, reviews, and posts the July bill run for the Enterprise Monthly cycle:

1. Sign in as a user holding `billrun_operate`. The sidebar shows the "Billing" section with Bill Runs.
2. Open **Bill Runs**. On load the page computes which runs should exist for each active cycle and inserts any missing (`ON CONFLICT (ref_bill_cycle_id, period_start) DO NOTHING`, so concurrent loads produce exactly one row). For a monthly cycle with `cycle_day` 1 billing **in arrears**, the 1–31 July run appears on 1 August as `SCHEDULED`.
3. The **Current & Upcoming** tab lists one operable run per cycle plus not-yet-due runs, disabled — an in-arrears run cannot execute before its period closes. The **Historical** tab lists completed runs read-only; a run in `PROCESSING_FAILED` or `DISTRIBUTION_FAILED` is not read-only history — it is rerunnable once the cause is fixed.
4. Select the current run and click **Run**. The service snapshots every eligible billing account into `bill_run_account` (freezing the population at trigger), sets the run to `PROCESSING`, and triggers the workflow engine with `{bill_run_id, period_start, period_end, ban_ids, attempt, gl_event_at}`. A second click is rejected while an execution is live.
5. The workflow fans out per account and signals `POST /api/billrun/{runId}/stage/{stage}/complete` per stage. Each signal inserts a `bill_run_account_stage` row first — the unique `(run, ban, stage, attempt)` constraint makes replays a 200 no-op — then advances that account. The app's stages run: **validation** (readiness), **collection** (claim the account's already-rated records from `rating.udr_rated`), **aggregation** writes `customer_bill` (category `trial`, stamping bill format, template version, and `payment_due_date`), **taxation** writes `customer_bill_tax_item`, **verification** writes exceptions and findings. There is no billing-side charge table — the charge records live in the rating store and are read from there for review.
6. When every account is terminal the run reaches `PROCESSED`. Run status is recomputed under a row lock on `bill_run`, never by incrementing a counter.
7. Review: the **Workflow** tab shows the stage timeline and pre-approval checks; **Customers & Bills** lists every account with its draft totals, drilling into charge lines read live from `rating`; **Uncharged** lists everything deliberately not charged; **Errors** lists hard errors with codes; **Audit** shows every action.
8. Fix the underlying data and **Rerun** — all or a subset — with a mandatory reason. The audit event (actor, accounts, prior totals, reason) is written *before* re-trigger; stages after the rerun point are invalidated for those accounts only; nothing already invoiced can be touched.
9. When the numbers are right, a **different** user holding `billrun_approve` opens **Approve & Post**. Pre-approval checks confirm the accounting period is open, GL mappings resolve, no bill totals are zero or negative (a backstop — zero-charge accounts are already excluded at Scoping), and the approver differs from the trigger actor. Confirm.
10. The run moves `APPROVED → POSTING`. Per account, in its own transaction: the app reads the account's claimed charge records from the rating store and stamps a `charge_checksum` + `posted_attempt` on the bill (no billing-side copy), one `INV` document is created and auto-posted (its reason code carries an unlimited `autoPostLimit`, so the run-level four-eyes is the sole second signature), the invoice number is consumed, `customer_bill` gets `ref_inv_document_id` and category `normal`, and the account becomes `INVOICED`. An account already carrying an invoice number is skipped, so a retry resumes rather than duplicates.
11. An account that failed is `PROCESSING_FAILED` during the run; at approval such accounts are recorded as `SKIPPED` — no charges, no bill, no invoice number consumed.
12. When every account is terminal-final the run reaches `INVOICED`: money is in the ledger, and **the next cycle's run becomes operable at this point**. It then passes through `DISTRIBUTING` — no configured targets in this release — to `COMPLETED`.
13. A user holding only `billrun_view` can follow all of the above read-only, but sees no trigger, rerun, approve, or cancel action.

## Features

### Bill run lifecycle
- Lazy materialization of run rows from `billing.bill_cycle` on page load — no scheduler, cron, or background worker in the application.
- Monthly in-arrears window derivation honouring `cycle_day` 1–28; `scheduled_run_date = period_end + 1`.
- Exactly one operable run per cycle; upcoming runs visible but disabled until their period closes; past-due runs operable oldest-first so a missed month never strands a period.
- Run states `SCHEDULED → PROCESSING → PROCESSED → APPROVED → POSTING → INVOICED → DISTRIBUTING → COMPLETED`, plus two rerunnable failure states `PROCESSING_FAILED` and `DISTRIBUTION_FAILED`, and `CANCELLED`.
- `INVOICED` means financially complete (postings done, numbers consumed); `COMPLETED` means operationally complete. Next-cycle operability keys off `INVOICED`, so a stalled downstream target can never block next month's billing.
- Historical runs read-only, filterable by cycle and status, CSV-exportable.

### Stage tracking and observability
- Stages: scoping, validation, usage collection (claim), aggregation, taxation, verification, posting, rendering, distribution — the first six built this release.
- `bill_run_account_stage` records status, timing, error class and code per `(run, account, stage, attempt)` — the drill-down surface and the idempotency guard in one table.
- Failure taxonomy: HARD (account fails the stage, run continues, account excluded at approval), SOFT (stage succeeds, finding raised), INFRA (retryable, no state change on retry success).
- Run-level counters treated as a cache; display derives from `bill_run_account`, with a test asserting stored == derived.

### Workflow integration & the charge boundary
- Trigger contract carrying the period window, account list, app-assigned attempt number, and the GL event date (`gl_event_at`, the cycle's billing-run day) — no rating policy (the bill run doesn't rate).
- Signal-based handoff: the completion call carries no charge payload; the app reads the charge records from the `rating` schema itself.
- Idempotency enforced solely by a database unique constraint on `(run, ban, stage, attempt)` — never by the orchestrator.
- Ownership boundary as a Postgres grant: rating has full rights on `rating.*` and `SELECT` on the billing tables it rates from; the app has `SELECT` on `rating.*` plus `UPDATE` on the one **claim marker** column of `rating.udr_rated` (the bill run stamps its run ref to claim the records it bills). No cross-schema foreign keys in either direction.
- Retention & immutability contract: the rating subsystem may not purge or overwrite an `APPROVED` run's charge records until `COMPLETED`, and once a record is posted it is permanently immutable — posting reads it, and any tampering with a posted invoice's lines is caught by the bill's `charge_checksum`.

### Rerun and correction
- Full or partial rerun while unapproved, from a selectable stage, with a mandatory reason.
- Audit event written before re-trigger, capturing actor, accounts, prior bill totals, and reason.
- Per-account stage invalidation: rerunning stage N discards outputs of later stages for those accounts only.
- Finalization guard is absolute: nothing carrying `ref_inv_document_id` is ever invalidated; posted charge records are frozen in the rating store, and tampering is caught by the bill's `charge_checksum`.

### Review and approval
- Draft bills reviewed on screen: per-account totals, charge lines with coverage windows, tax items, exceptions, and failures.
- Uncharged tab listing every account/subscription deliberately not charged (started, ceased, or suspended mid-period), with the uncharged window and an indicative value, exportable for manual billing.
- Pre-approval checks panel: accounting period open, GL mappings resolvable, no zero/negative totals (backstop; zero-charge accounts excluded at Scoping), approver ≠ trigger actor, all accounts terminal.
- Approval stamps `approved_by`, `approved_at`, and the immutable run total.

### Posting to the ledger
- Per-account transaction: read the claimed charge records + compute `charge_checksum`, create the `INV`, auto-post, consume the invoice number, back-link, flip status.
- Resumable and idempotent — an account already carrying an invoice number is skipped on retry.
- Invoice numbers (configurable prefix + format) consumed only on successful posting; a trial or a skipped account never reserves one. After approval, posting runs without gaps, though a rollback can leave a rare gap (acceptable, not a strict guarantee).
- `gl_event_at` per cycle: resolves to the **billing-run day** (`scheduled_run_date`, e.g. the 1st of the month after the service period) — when billing ran and the bill is deemed complete, not the later posting timestamp — and is written to the INV's `document.event_at`, so revenue posts to the GL period of the run month. `entry_date` is the invoice date and is what `payment_due_date` counts from.
- Accounting-period locks respected; a **period-close guard** refuses to close a period while a run is still posting into it; `PERIOD_CLOSED` is a first-class per-account posting error with a retry action.

### Health and recovery
- Heartbeat: every stage signal bumps `last_progress_at`.
- STALLED is derived on read, not stored — no background job writes it — appearing when a `PROCESSING` run exceeds its cycle's stall threshold.
- Operator actions on a stalled run: **Check status** (reconcile against the workflow engine) and **Cancel run** (kill the execution, set `CANCELLED`, reset accounts to `PENDING`, clear the execution reference). Cancellation consumes no invoice numbers and re-materializes the period cleanly.

### Access control and audit
- Three permissions: `billrun_view` (list, drill down, export), `billrun_operate` (trigger, rerun, cancel), `billrun_approve` (approve and post). Operate and approve imply view.
- New **Billing Viewer** role carrying `billrun_view` alone, for Finance and Internal Audit.
- Four-eyes enforced in the service layer: approver ≠ the user who triggered the final attempt.
- Machine-to-machine ingest endpoints carry no session semantics: bearer service token, constant-time compare, never logged, Zod-validated, HTTPS only, rejected unless the run is `PROCESSING`.
- Audit events for materialization, trigger, stage completion, rerun, approval, cancellation.

## In scope

- New "Billing" sidebar section with the Bill Runs list (Current & Upcoming, Historical) and the run detail page (Workflow, Customers & Bills, Uncharged, Errors, Audit tabs), plus the posting progress view.
- Tables in the existing `billing` schema: `bill_run`, `bill_run_account`, `bill_run_account_stage`, `customer_bill`, `customer_bill_tax_item`, `bill_template_version`, with per-entity ID sequences. No billing-side charge copy — the per-run record tables (`bill_run_account`, `bill_run_account_stage`, `customer_bill`, `customer_bill_tax_item`) are partitioned on a generic `period_partition` key (default monthly), 7-year detach-and-archive via `pg_partman`/`pg_cron`.
- The `rating` schema, its dedicated Postgres role and grants, and the claim-marker `UPDATE` the app holds on `rating.udr_rated`.
- Additive changes to Accounts-owned objects: `document_inv_seq`, `'INV'` added to the document type check, an INV reason code with unlimited `autoPostLimit`, GL mapping rows, and the period-close guard.
- Route handlers under `app/api/billrun/` for stage completion and status, service-token authenticated, calling the same service layer as the server actions.
- Server actions for materialize, trigger, rerun, cancel, approve, and post, each wrapping validate → mutate → audit in one transaction.
- Monthly on-cycle runs, recurring subscription charges only.
- Workflow-engine deployment (namespace, definition, private-network placement, secret wiring) and the pipeline orchestration, including injectable HARD/SOFT/INFRA failures and on-demand stalling for testing.
- RBAC permission rows and the Billing Viewer role seed.
- Unit and integration tests (vitest) plus one end-to-end journey.

## Out of scope

- **The rating engine** — v1 runs the pipeline against a **stub** `rating.udr_rated`; the collection/claim auto-completes and the deployment runs in **stub-data mode** (an environment flag). The real engine, its charge computation, and live UDRs arrive with the rating/charging module.
- **Rendered invoice artifacts** — no PDF generation, no `bill_format` catalog UI, no draft proofs. The invoice *postings* are real; there is no customer-facing invoice *document* yet.
- **Distribution** — no dispatch, no email, no downstream feeds. `DISTRIBUTING` exists in the state machine but is never entered (no targets configured).
- **Proration** — any account holding a partial-period subscription is excluded from the automated run entirely and billed manually (billing only its full-period subs would post an under-charged invoice); the excluded accounts and subscriptions are listed as exceptions. No account is partially billed.
- **One-time (`once`) / usage / ad-hoc OCC charge sourcing** — v1 bills recurring subscription charges only; other charge sourcing is a deferred upstream (charging-module) dependency.
- **Off-cycle and on-demand runs** — `run_type` is modelled but only `onCycle` is written. Consequently there is no closure final bill and no automated recovery of a skipped account's missed revenue; both are handled as manual DBN/ADJ documents in Accounts → Transactions, and that workaround must be in the RevOps runbook.
- **Multi-frequency cycles** — materialization and window derivation handle monthly only.
- **Per-invoice approval workflow** — approval is run-level; individual bills are not approved, held, or released.
- **Scheduled (cron) run creation** — runs are materialized on page view and triggered by hand.
- **Credit-note automation** — post-invoice corrections remain manual CRN through Accounts → Transactions.
- **External TMF APIs** — the data shapes follow TMF678/TMF666, but no REST surface is exposed.
- **Workflow-engine Enterprise-tier hardening** — scoped service-account tokens are a phase-2 change from the OSS Basic-Auth outbound.

## Success criteria

1. Opening Bill Runs on or after the 1st creates the prior month's run for every active monthly cycle exactly once, verified under concurrent page loads, with no scheduler or background process in the application.
2. A user with `billrun_operate` can complete the full core user flow — trigger, watch stages advance, review draft bills, rerun a subset, hand over — and a **different** user with `billrun_approve` can approve and post, with the four-eyes check rejecting an attempt by the trigger actor.
3. Every stage signal is replay-safe: re-sending the same `(run, account, stage, attempt)` returns 200 and changes nothing, and a signal after approval is rejected with 409.
4. Rerunning a subset invalidates only later stages for those accounts, never touches an account already carrying an invoice number, and writes its audit event — with prior totals and reason — before re-trigger.
5. The database refuses to delete a `customer_bill` carrying `ref_inv_document_id`, unconditionally; posted charge records are frozen in the rating store, and a change to a posted invoice's lines is detected by the bill's `charge_checksum`.
6. Approving posts one `INV` per billed account with sequential numbering (configurable prefix/format; a rollback gap is tolerable), correct `ban.A/R ← revenue` and tax legs in pgledger, `event_at` = `gl_event_at` (the cycle's billing-run day) and `entry_date` on the invoice date; a mid-batch `PERIOD_CLOSED` failure leaves every other invoice posted and the run resumable, and retrying skips accounts already invoiced.
7. Accounts that failed are `PROCESSING_FAILED` during the run and recorded as `SKIPPED` at approval — no charges, no bill, no invoice number consumed; the run still reaches `INVOICED` then `COMPLETED` with them listed.
8. Any account excluded because it holds a partial-period subscription — and each such subscription — appears on the Uncharged tab with its uncharged window, and the tab is exportable.
9. A run left without a heartbeat past its stall threshold displays as STALLED on next view; **Check status** reconciles it against the workflow engine and **Cancel run** releases it to `CANCELLED` with all accounts reset and no numbers consumed.
10. A run parked in `DISTRIBUTING` does not prevent the next cycle's run from being triggered — next-cycle operability keys off `INVOICED`.
11. A user holding only `billrun_view` can reach every read surface and no mutating action, verified by direct server-action and route-handler calls, not only by navigation.
12. The ingest route handlers reject a missing or invalid bearer token with 401, carry no session semantics, and never log the token.
13. In **stub-data mode** (v1) every run is visibly marked in the UI so its fixture figures are never mistaken for production charges, and the stub/UAT environment is isolated from any ledger holding real Accounts data.
14. `npm run typecheck`, `npm run lint`, and the full vitest suite pass; the module follows the existing `context/` documentation conventions with a progress tracker kept current.
