# Billing Management — Bill Run — Phase 2 Update Overview

**Source of truth for this update:** `_updatemodule-billing-billrun-phase2-plan.md`.
**Updates:** the phase-1 design in `_newmodule-billing-billrun-plan.md` and the boundary in `_newmodule-billrun-rating-workflow-plan.md`.
**Users:** Revenue Operations (RevOps — business, works only in the app) and BSS Ops (technical, works at the Kestra engine layer).

## Overview

The Bill Run module is where Revenue Operations executes and controls monthly bill runs: materialising the run for each bill cycle, processing each account's already-rated usage into a draft bill, approving it under a four-eyes gate, posting one `INV` document per account into the ledger, and distributing the resulting invoices and reports. Phase 1 delivered this as an operable app surface but stubbed the work: the workflow engine only signalled stage completion, all stage logic ran inside the app, and rendering and distribution were not built. Phase 2 wires the module to a **Kestra workflow-management engine** and moves the billing pipeline's execution into it — with **placeholder steps that return success now and the detailed billing logic filled in later** — so the app becomes the control plane (trigger, approve, reject, rerun) while Kestra runs the processing and distribution, invoices are rendered and stored, and a run flows all the way to `COMPLETED`, including the reject→reprocess and distribution-failure loops.

## Goals

1. Stand up Kestra as the bill run's **workflow-management engine** (evaluation), addressed through a named engine registry (`billrun`) so its physical instance is a deployment setting, not hard-coded.
2. Move the billing **processing** stages (validate `udr_rated` → correlate → calculate → update bill data → apply tax → verify) out of the app and into a Kestra **processing flow**, as placeholder tasks that return success now.
3. Keep the app as the **control plane**: trigger, approve, reject, and operator rerun-selection remain app actions; approval and posting stay app-only.
4. Enforce the two-writer boundary with database grants: a new least-privilege `billrun_runtime` role writes only bill-data; the app remains sole writer of run-state, progress, and idempotency.
5. Make a run reach `COMPLETED` as **two Kestra executions** (processing, then distribution) bridged by the app's `bill_run.status` state machine.
6. Handle **rejection**: an approver can reject at the gate, which flips the claimed rows to `REJECTED` and sends the run back to reprocess for another approval round.
7. **Render and store** each approved invoice as an immutable PDF, and let reviewers preview a draft (PRO-FORMA) invoice before approval.
8. Wire **distribution** to Kestra as a transport-only flow with one loopback target, exercising both the success (`COMPLETED`) and mandatory-failure (`DISTRIBUTION_FAILED` → rerun) paths.

## Core user flow (start to finish)

1. **Materialise.** RevOps opens Billing → Bill Runs. The page lazily inserts the current period's `bill_run` (`SCHEDULED`) for each active bill cycle. No scheduler.
2. **Trigger.** A `billrun_operate` user selects the operable run and clicks Run. The app snapshots eligible accounts into `bill_run_account`, sets the run to `PROCESSING`, and triggers **Kestra execution #1 (processing)** on the `billrun` engine, passing `{bill_run_id, period_start, period_end, ban_ids, attempt, gl_event_at}`.
3. **Process (Kestra, stages 2–6).** The processing flow fans out per account. Each placeholder stage calls back the app's existing M2M endpoint (`POST /api/billrun/{runId}/stage/{stage}/complete`) so the app advances `bill_run_account_stage` (replay-safe on `(run, ban, stage, attempt)`) and bumps the heartbeat. The Collection stage claims the account's usage: `rating.udr_rated` rows flip `RATED → BILL_DRAFT`. The flow writes `customer_bill` (trial) and `customer_bill_tax_item`. Execution #1 terminates at `PROCESSED` — it does not wait for approval.
4. **Review.** The run reaches `PROCESSED`. RevOps opens the drill-down: per-stage timeline, per-account draft totals and charge lines (read from `rating.udr_rated`), Uncharged, Errors, Distribution, and Audit tabs. A reviewer can **preview a draft PRO-FORMA invoice** for any account (rendered on-demand, watermarked, no invoice number, not stored).
5. **Correct (optional).** A `billrun_operate` user **reruns** selected accounts from a chosen stage (mandatory reason; audit written before re-trigger; later stages invalidated; drafts re-derived under the `ref_inv_document_id IS NULL` guard).
6. **Reject (optional).** A `billrun_approve` user **rejects** the whole bill or selected accounts at the gate: the claimed rows flip `BILL_DRAFT → REJECTED`, the run returns to a reprocessable state, and reprocessing re-claims in-scope `REJECTED`/`RATED` rows back to `BILL_DRAFT` for the next approval round.
7. **Approve.** A different `billrun_approve` user (≠ the final trigger actor) approves. Pre-approval checks pass (period open, GL mappings resolvable, no zero/negative totals, approver ≠ trigger actor, all accounts terminal). Claimed rows flip `BILL_DRAFT → BILL_APPROVED`; the run moves to `APPROVED` then `POSTING`.
8. **Post + render + store (app, per account).** For each non-failed account, in its own transaction: read the claimed `rating.udr_rated` rows, compute `charge_checksum`, create and auto-post one `INV` through the Accounts document engine (consuming the invoice number), then **render the final invoice PDF and store it** in `bill_run_invoices` (immutable, 7-year retention). Failed accounts are marked `SKIPPED`. When all accounts are terminal, the run reaches `INVOICED` and the next cycle unblocks.
9. **Distribute (Kestra execution #2).** The app triggers a separate distribution execution, handing it references to the stored artifacts. The transport-only flow delivers each artifact to the **loopback** target and signals per-target outcomes. All mandatory targets landing → `COMPLETED`; a mandatory-target failure → `DISTRIBUTION_FAILED` (rerunnable; posted invoices untouched).

## Features by category

**Workflow-management integration**

- Named engine registry (`rating`, `billrun`); the app resolves the `billrun` engine by name; dev/test/default may map both to one Kestra instance, prod may split.
- Kestra **processing flow** template (per-account fan-out, placeholder stage tasks returning success, error + `finally` terminal handlers) calling the app's existing M2M stage endpoints.
- Two-execution lifecycle (processing, then distribution) bridged by `bill_run.status`.
- Heartbeat, derived `STALLED` display, operator reconcile/cancel — carried over and adapted to two executions.

**Billing data & the boundary**

- New `billrun_runtime` DB role: column-scoped `INSERT`/`UPDATE` on `customer_bill` + `customer_bill_tax_item` and the six claim columns on `rating.udr_rated`; no access to run-state tables, `billing.document`, or pgledger.
- `udr_rated` status lifecycle adopted: `RATED → BILL_DRAFT → BILL_APPROVED`, and `BILL_DRAFT → REJECTED`; no inserts by the billing side.
- App remains sole writer of `bill_run`, `bill_run_account`, `bill_run_account_stage` (run-state, progress, idempotency).

**Control plane (app actions)**

- Trigger (`billrun_operate`), Rerun-selection (`billrun_operate`), Reject (`billrun_approve`), Approve (`billrun_approve`).
- Reject at the gate → `REJECTED` → reprocess → re-approve loop.
- Four-eyes gate (approver ≠ final trigger actor); posting app-only.

**Rendering & storage**

- Playwright (headless Chromium) HTML/CSS → PDF, in-app.
- Draft PRO-FORMA preview: on-demand, watermarked, no invoice number, not stored.
- Final render + store: per account after posting, immutable, 7-year retention, in `bill_run_invoices` with a checksum.

**Distribution**

- Kestra distribution flow, transport-only, separate execution.
- One `loopback` target (`is_mandatory`) with success and forceable-failure paths.
- Per-target delivery log; `INVOICED → DISTRIBUTING → COMPLETED` and `DISTRIBUTION_FAILED → rerun-distribution`.

## In scope

- Named workflow-engine registry and the `billrun`-engine resolution in the outbound client.
- Kestra processing flow template with placeholder stage tasks that call back the app's M2M endpoints; run reaches `PROCESSED` for real.
- `billrun_runtime` role and its column-scoped grants — all in the billing-owned `db/bootstrap/billrun-db-roles.sql` (incl. the `udr_rated` claim grant), run after the rating bootstrap; no rating-script edit.
- The `udr_rated` status lifecycle reconciliation (`BILL_DRAFT`/`BILL_APPROVED`/`REJECTED`) in the billmgmt docs and code.
- Reject action (`billrun_approve`) and the reject→reprocess loop.
- Two-execution lifecycle bridged by the app state machine.
- Playwright renderer: draft (on-demand, watermarked, ephemeral) and final (per-account, post-posting, stored).
- `bill_run_invoices` table + `invoices/` blob archive + lifecycle policy.
- Kestra distribution flow with one loopback target; per-target distribution outcome log.
- Small `_SAMPLE_*` `udr_rated` sample dataset — a rating-owned row-factory composed by a billing-owned scenario, run via a prod-guarded `db:seed-sample` (never in production).
- Error + `finally` handlers on both flows; the adapted heartbeat/stall/cancel path.

## Out of scope

- Real billing computation logic inside the processing flow (validation math, correlation, calculation, tax rules) — placeholders return success this phase.
- Production rendering template system: `bill_template_version` production use, `bill_format` variants, i18n, legal footers.
- Real distribution targets (customer portal, AR/collections feed, statutory submissions, email) — only the loopback mock.
- Per-run reports/feeds/statutory as real outputs; the per-run `bill_run_output` table.
- The live rating engine dependency — `udr_rated` comes from the `_SAMPLE_*` seed, not the real PRP→RP→RL pipeline.
- BSS Ops raw-feed reprocessing (belongs to the rating module).
- Production enforcement of a split engine topology (a deploy-time decision, not code).
- Proration, one-time/usage/OCC charge sourcing, off-cycle runs, multi-frequency cycles, credit-note automation (unchanged from phase 1).
- Migration to Kestra Enterprise (scoped per-flow tokens).

## Success criteria

- A run triggered in the app starts a real Kestra processing execution that fans out per account, calls the app's M2M endpoints, and reaches `PROCESSED`; a replayed `(run, ban, stage, attempt)` signal returns a 200 no-op.
- `billrun_runtime` can write `customer_bill`, `customer_bill_tax_item`, and the `udr_rated` claim columns, and is refused (per column/table) on `bill_run`, `bill_run_account`, `bill_run_account_stage`, `billing.document`, pgledger, and `bill_run_invoices`.
- The claim moves usage `RATED → BILL_DRAFT`; approval moves it `BILL_DRAFT → BILL_APPROVED`; reject moves it `BILL_DRAFT → REJECTED`; reprocess re-claims `REJECTED`/`RATED → BILL_DRAFT`; reject is refused once a row is `BILL_APPROVED` or posted; no billing-side `INSERT` into `udr_rated`.
- An approver can reject the whole run or selected accounts with a reason recorded in the billing audit; the run returns to reprocess and can be re-approved in a later round.
- Processing execution #1 terminates at `PROCESSED` without waiting for approval; after posting, distribution execution #2 drives `INVOICED → DISTRIBUTING → COMPLETED`; the next cycle is operable at `INVOICED`, not `COMPLETED`.
- A draft preview renders on demand, is watermarked PRO-FORMA, carries no invoice number, and is never stored; a rerun or reject leaves no stored artifact.
- After each account posts, its final invoice PDF is rendered and stored in `bill_run_invoices` as an immutable, 7-year-retained record whose checksum detects later tampering.
- The distribution flow delivers stored artifacts to the loopback target and logs a per-target outcome; a forced mandatory-target failure yields `DISTRIBUTION_FAILED` and is rerunnable without touching posted invoices; an advisory failure does not block `COMPLETED`.
- The app resolves the `billrun` engine by name; mapping both engines to one instance (dev/test) and to separate instances (split) both route correctly.
- A full journey passes end to end against seeded `udr_rated`: materialise → trigger → process → review → reject → reprocess → approve → post → render+store → distribute → `COMPLETED`.
