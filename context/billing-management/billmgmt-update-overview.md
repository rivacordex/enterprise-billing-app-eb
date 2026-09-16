# Billing Management — Bill Run — Phase 4 Update Overview

*Date: 2026-09-16 · Users: Revenue Operations (RevOps, in-app) and BSS Ops (Kestra engine + deploy layer) · Derived from the 2026-09-16 planning discussion and `billmgmt-gap-assessment.md`. Phase 1–3 current-state lives in `billmgmt-project-overview.md`.*

## Overview

The Billing Management module is where the Revenue Operations team runs monthly bill runs: it materialises a `bill_run` per billing cycle, turns each account's rated usage and derived recurring charges into a draft bill (`customer_bill` + `customer_bill_line`), approves it under a four-eyes gate, posts one `INV` document per account into pgledger through the Accounts engine, renders and stores the final invoice PDF, and distributes invoices and the run report over SFTP. Phases 1–3 built all of that machinery, but a triggered run cannot finish on its own because the processing flow's **signal-back is stubbed**: `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml` contains zero `io.kestra.plugin.core.http.Request` tasks — its per-stage stage-complete POSTs and its `on_error`/`on_finally` terminal `/status` POST are `io.kestra.plugin.core.log.Log` placeholders — so accounts never auto-reach `PROCESSED` and the run wedges in `PROCESSING`. Phase 4 wires that signal-back (success **and** terminal failure), proves the full `SCHEDULED → COMPLETED` lifecycle locally on the `ci` seed, and makes the production deploy path deployable-and-wired with the actual cloud cutover left as a gated ops step; it introduces **no new database schema**.

## Goals

1. Add real per-stage signal-back to `bill_run_processing.yml`: after each stage's SQL, a `core.http.Request` POST to `/api/billrun/{runId}/stage/{stage}/complete` with `Authorization: Bearer {{ secret('BILLRUN_APP_TOKEN') }}` and body `{ban_id, attempt, status: DONE|FAILED, error_class?, error_code?, error_detail?}`.
2. Replace the `Log` stubs with real terminal `/api/billrun/{runId}/status` POSTs — `errors: on_error` on a `FAILED` execution and `afterExecution: on_killed` on a KILL — so a **whole-execution** failure settles the run to `PROCESSING_FAILED` instead of relying on the stall timeout. A **contained per-account** HARD failure is different: it is a `WARNING` execution, so the *account* settles to `PROCESSING_FAILED` via its own per-account `FAILED` stage POST while the *run* derives `PROCESSED` (a mixed terminal set), with the failed account marked `SKIPPED` at approval and the run rerunnable — no run-level terminal-failure push for a partial run.
3. Make a triggered run reach `PROCESSED` on its own — accounts auto-advance, the Workflow stage timeline fills, and Approve appears on a healthy run with no stall banner and no out-of-band signal replay.
4. Assert the full lifecycle locally on the `ci` seed: `SCHEDULED → PROCESSING → PROCESSED → APPROVED → POSTING → INVOICED → DISTRIBUTING → COMPLETED`, including reject → re-rate → reprocess, a forced processing failure that settles, and distribution with a forced mandatory failure → `DISTRIBUTION_FAILED` → rerun.
5. Confirm the stall/reconcile gate no longer fires on a healthy run and still catches a genuinely wedged one; close the bm16/bm20 live-Kestra gate locally.
6. Make production deployable-and-wired: provision the `BILLRUN_RUNTIME_DATABASE_URL`, `billrun-engine-auth`/`-url`, and SFTP Key Vault secrets and their consumer mapping into the shared `workflow-engine` Container App bicep, ready the (still-gated) deploy flags, and correct the `template.yml` "separate repo, TBD owner" fiction.
7. Mirror bm34's distributor callback pattern verbatim — reachability (`host.docker.internal` / internal ingress), `Bearer` token auth, retry/`allowFailure`, and the `attempt` guard that swallows a superseded round's straggler POST.

## Core user flow

1. **Materialise.** RevOps opens Billing → Bill Runs; the page lazily inserts the current period's `bill_run` (`SCHEDULED`) for each active cycle. No scheduler.
2. **Trigger.** A `billrun_operate` user selects the operable run and clicks Run. The app snapshots eligible accounts into `bill_run_account`, sets the run `PROCESSING`, and triggers Kestra execution #1 (processing) with `{bill_run_id, period_start, period_end, ban_ids, attempt, gl_event_at}`.
3. **Process.** Per account, the flow runs Validation → Collection (correlate `udr_subscriber_ref_id → product_inventory → billing_account_id`, claim `RATED → BILL_DRAFT`) → Aggregation (write `customer_bill` + `customer_bill_line`, USAGE + RECURRING) → Taxation (`0.00`) → Verification. **After each stage it POSTs a `DONE` stage-complete signal** (new in Phase 4).
4. **Auto-advance to `PROCESSED`.** The app records each stage signal, advances the account, and recomputes the run; the terminal `verification` signal flips the account to `PROCESSED`. When all accounts are terminal the run reaches `PROCESSED` — with no out-of-band call.
5. **Review.** RevOps opens the drill-down: Workflow timeline, Customers & Bills (`customer_bill_line` face + `udr_rated` drill-down + PRO-FORMA preview), Uncharged, Errors, Distribution, Audit.
6. **Reject / rerun (optional).** Reject (`billrun_approve`) or rerun (`billrun_operate`, mandatory reason) releases the claimed rows back to `RATED` and re-derives the trial bill; BSS Ops can then reload corrected usage and the run is reprocessed.
7. **Approve → Post.** A different `billrun_approve` user (≠ the final trigger actor) approves; claimed rows flip `BILL_DRAFT → BILL_APPROVED`; the run moves `APPROVED → POSTING`. Per account: compute `charge_checksum`, post one `INV`, consume the invoice number, render and store the final PDF in `bill_run_invoices`. The run reaches `INVOICED`; the next cycle unblocks.
8. **Distribute → Complete.** The app triggers Kestra execution #2 with one `invoice_pdf` per stored invoice plus a `report_csv`; the flow downloads each from blob storage and SFTPs it, POSTing a `DELIVERED`/`FAILED` outcome per artifact. Every mandatory artifact delivered to every mandatory target → `COMPLETED`.
9. **Failure path.** A HARD-failing account's stage POSTs `FAILED`, settling that **account** to `PROCESSING_FAILED` (not the stall timeout); the **run** derives `PROCESSED` (a mixed terminal set), with the failed account marked `SKIPPED` at approval and the run rerunnable. A run-level `PROCESSING_FAILED` is reserved for a whole-execution failure (a `FAILED` execution via `on_error`, or a KILL via `on_killed`). A forced mandatory distribution failure yields `DISTRIBUTION_FAILED`, rerunnable for only the failed artifacts.

## Features

### Processor signal-back (the core build)
- Per-stage `DONE` `http.Request` POSTs to `/api/billrun/{runId}/stage/{stage}/complete`, carrying `{ban_id, attempt, status, error_*}` — no charge payload (the app receiver stays record-only).
- Real `on_error` (terminal per-account/run `FAILED`) and `on_finally` (always a terminal `/status`, Inv #1 obligation) POSTs replacing the `Log` stubs.
- `attempt`-guarded idempotency, retry/`allowFailure`, and `Bearer BILLRUN_APP_TOKEN` auth mirroring bm34; the app-side receiver (`handle-stage-signal.ts`, `TERMINAL_STAGE='verification'`) is untouched.

### End-to-end assertion + reconcile alignment
- Extend `scripts/billrun-live-kestra-smoke.ts` to assert `SCHEDULED → COMPLETED` on the `ci` seed, including reject→reprocess, forced processing-failure→settle, and distribution + forced dist-failure→rerun.
- Verify the stall/reconcile gate does not fire on a healthy run and still catches a wedged one; close the bm16/bm20 live-Kestra gate locally.

### Production wiring (deployable, gated)
- Key Vault secrets + consumer mapping into `infra/bicep/modules/workflow-engine-container-app.bicep`: `BILLRUN_RUNTIME_DATABASE_URL`, `billrun-engine-auth`/`-url`, SFTP key/known-hosts; the `billrun_runtime` password provisioning step.
- No new container — the shared `workflow-engine` (collapsed topology) already hosts the `billrun` namespace; the `local-dev` flow is promoted as the production flow.
- Deploy flags (`deployWorkflowEngine`, `deployRatingFlows`, the billrun flow deploy, `runBillrunLiveKestraSmoke`) readied but left gated for the ops cutover; the `template.yml` "separate repo, TBD owner" text corrected; the taxation-`0.00` interim and the cutover runbook recorded.

### Data, storage & access (unchanged)
- **No new schema, no migrations.** Signal-back reuses `bill_run_account_stage`; `0.00` tax means no `customer_bill_tax_item` rows; reject, post, invoice-store and distribution all already exist.
- No new auth surface: `BILLRUN_APP_TOKEN` (flow→app), the `billrun_runtime` DB role, and RevOps RBAC + four-eyes are already built. The only new access work is provisioning the production Key Vault secrets and worker→app reachability inside Container Apps.

## In scope

- Real processor signal-back in `bill-run-processor/local-dev/bill_run_processing.yml`: per-stage `DONE` POSTs **and** terminal `FAILED`/`/status` POSTs (`on_error`/`on_finally`).
- Local end-to-end `SCHEDULED → COMPLETED` assertion on the `ci` seed, including reject → re-rate → reprocess, forced processing-failure → settle, and distribution + forced dist-failure → rerun; reconcile/stall-gate alignment.
- Promotion of the deployable `local-dev` flow as the production flow (signal-back written once).
- Production bicep + Key Vault secret wiring + consumer mapping; gated deploy flags; `template.yml` fiction correction; taxation-`0.00` ratification; the production cutover runbook.

## Out of scope

- **Real taxation** — `0.00` stands as the ratified interim (`total = subtotal`); no jurisdiction/category tax rules.
- **Supersede-with-new-`udr_rated`** and any change to reject/approve/post logic — the release → re-rate → reprocess path is already built (bm24); Phase 4 only makes it reachable.
- **New database schema or migrations.**
- **A real production cloud run** — the deploy path is delivered deployable-and-wired; the cutover (flip flags, run the live smoke against a real engine + SFTP) is a gated ops step after the phase.
- **A separate workflow-management flow repo** — superseded by promoting the `local-dev` flow.
- **Kestra Enterprise / scoped per-flow tokens** — unchanged deferral.

## Success criteria

1. A freshly triggered run drives itself `SCHEDULED → COMPLETED` on the `ci` seed with no out-of-band calls: accounts auto-reach `PROCESSED` via real stage-complete signals, the Workflow timeline fills, Approve appears with no stall banner, and post → store → SFTP distribute → `COMPLETED` all follow.
2. A HARD-failing account reaches `PROCESSING_FAILED` via its per-account `FAILED` stage-complete POST (not the stall timeout); the run derives `PROCESSED` (mixed terminal set) with the failed account `SKIPPED` at approval and remains rerunnable. A whole-execution `FAILED`/KILL settles the run itself to `PROCESSING_FAILED` (via `on_error`/`on_killed`).
3. A forced mandatory distribution failure yields `DISTRIBUTION_FAILED` and reruns only the failed artifacts to `COMPLETED`; a duplicate or stale-attempt outcome is a 200 no-op.
4. The stall/reconcile gate does not fire on a healthy run and still catches a genuinely wedged one; the bm16/bm20 live-Kestra gate closes locally.
5. Production is deployable-and-wired: `BILLRUN_RUNTIME_DATABASE_URL`, engine, and SFTP secrets plus their consumer mapping are present in the `workflow-engine` bicep, the deploy flags are readied (still gated), the `template.yml` fiction is corrected, and the cutover runbook is recorded — with no new migration introduced.
6. `npm run typecheck`, `npm run lint`, and the full vitest suite pass; `billmgmt-progress-tracker.md` records Phase 4 delivery.
