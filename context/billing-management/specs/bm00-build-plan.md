# Bill Run — Build Plan (Units, in build order)

Decomposition of the Billing Management (Bill Run) module into build units. Source of truth: `billmgmt-project-overview.md`, `billmgmt-architecture.md` (20 Invariants), `billmgmt-code-standards.md` (file tree §7, permission map §8, guardrail tests §9), `billmgmt-ai-workflow-rules.md` (unit discipline), `billmgmt-ui-context.md` (tokens), and for **Phase 2** `_updatemodule-billing-billrun-phase2-plan.md` (+ decisions §15) and `billmgmt-update-overview.md`. Stack per `context/architecture.md` §1 and `billmgmt-architecture.md` §1.

**Decomposition rules applied:** each unit produces **one visible result**; each stays within **one system boundary**; **dependencies land just-in-time** (schema/infra is built by the first unit that needs it, never earlier); units **always done together are merged** (e.g. Scoping into Trigger, Claim into Draft-bill); units with **no standalone visible result are merged** into the adjacent unit that surfaces them (e.g. the stub-mode banner, the counters cache, the completion transition).

**Legend per unit:** _Boundary_ = the layer/owner the unit lives in · _Builds_ = what ships · _Visible result_ = what you can demo · _Depends on_ = what must already exist. Every unit finishes green (`tsc`/lint/tests incl. route × level matrix) and carries its own tests + doc-sync before the next starts.

**External prerequisites (not units of this module):** `core.APPUSER` + RBAC platform (exists); `billing.bill_cycle` and `billing.billing_account` + subscription tables (Accounts / Customer / Product-Ordering modules); the pgledger + Accounts document engine (`postDocument`); a deployed workflow engine (Kestra OSS) reachable on the private network.

---

> ## Status — Phase 1 DELIVERED · Phase 2 NEW (this session)
>
> **Phase 1 (Units 1–13, specs `bm01`–`bm13`, Phases A–E below) is DELIVERED** — the entire original plan shipped and was multi-agent-reviewed in the codebase (see `billmgmt-progress-tracker.md`; the sole remaining item is environmental — apply migration `0033` and run the suites against a real Postgres). **Retained for reference; do not rebuild.**
>
> **Phase 2 (Units 14–21, Phases F–I) is NEW this session** — the workflow-management wiring, rendering & distribution update (`_updatemodule-billing-billrun-phase2-plan.md`). These are the units to build next; they build **on top of** the delivered Phase 1 and rewire the pipeline to run in the `billrun` Kestra engine (B-fat).
>
> **Phase-2 external prerequisites (beyond Phase 1's):** the **rating** module's `rating.udr_rated` schema (rm01) and its bootstrap incl. `REVOKE CONNECT … FROM PUBLIC` (rm03) — `billrun_runtime` is created **after** it (D15); a `udr_rated` **row-factory** exposed by rating for the `_SAMPLE_*` seed (D28); a deployed **`billrun` Kestra engine** (shared with rating or its own instance — deploy-time, D25) able to run the `bill_run_processing` / `bill_run_distribution` flows.

---

# Part 1 — Phase 1 (Units 1–13) — DELIVERED

## Phase A — Shell & lifecycle read

### Unit 1 — Billing section & RBAC scaffold

- **Boundary:** auth/RBAC + app shell.
- **Builds:** the three `billrun_*` permissions (`view`/`operate`/`approve`) + the **Billing Viewer** role, seeded by migration; typed constants in `auth/` (`PERMISSIONS.BILLRUN_VIEW/_OPERATE/_APPROVE`); a `NAV_SECTIONS` "Billing" entry; the `/billing/bill-runs` route with its `billrun_view` guard, `loading.tsx`/`error.tsx`, and an empty state.
- **Visible result:** a permission-gated **Billing → Bill Runs** page renders; a user without `billrun_view` is blocked; the three permissions are grantable in Administration.
- **Depends on:** platform auth/RBAC + nav (exist).

### Unit 2 — Bill Runs list + lazy materialization

- **Boundary:** `billing` schema + `bill-runs` read path.
- **Builds:** `billing.bill_run` table + migration + `BRN` sequence (not partitioned); the `RunStatus` union + CHECK; the materialize service (compute due runs from `bill_cycle`, monthly in-arrears window `cycle_day` 1–28, `scheduled_run_date = period_end + 1`, `ON CONFLICT (ref_bill_cycle_id, period_start) DO NOTHING`) run in the list page's server path; `RunListRow` read model; `BillRunList` with **Current & Upcoming** (one operable run/cycle, upcoming disabled, past-due operable oldest-first) and **Historical** (read-only, filter by cycle/status, CSV export); `RunStatusBadge`; the always-on `StubDataBanner`/`StubBadge` driven by the stub-mode env flag.
- **Visible result:** opening Bill Runs materializes the prior month's `SCHEDULED` run per active cycle (exactly once under concurrent loads) and lists current/upcoming + historical runs; the stub banner shows.
- **Depends on:** Unit 1; `billing.bill_cycle` (Accounts).

## Phase B — Trigger & the orchestration spine

### Unit 3 — Trigger a run (+ Scoping + outbound engine)

- **Boundary:** `bill-runs` operate path + outbound workflow integration.
- **Builds:** `billing.bill_run_account` table + `period_partition` partition registration (`pg_partman`) + `BRA` seq + `AccountStatus` union; the **Scoping** logic (snapshot eligible accounts at trigger, freeze population, exclude any account holding a partial-period subscription → exception); `gl_event_at` resolution (= `scheduled_run_date`); the trigger service (→ `PROCESSING`, `last_progress_at`, store `workflow_execution_id`) + the generic double-trigger guard; the outbound engine client (Basic-Auth from Key Vault, private network) and a thin deployed flow; the `trigger-run.action.ts` (`billrun_operate`); the featured Deep-Petrol **Run** CTA on `RunActionCard` + `TriggerRunDialog`.
- **Visible result:** clicking **Run** on an operable run snapshots its accounts, flips it to `PROCESSING`, and starts a real workflow execution; a second click is rejected.
- **Depends on:** Unit 2; `billing.billing_account` + subscriptions; deployed workflow engine + outbound credential.

### Unit 4 — M2M stage ingest + stage-timeline observability

- **Boundary:** M2M Route Handlers (`app/api/billrun/*`) + `bill-runs` detail read.
- **Builds:** `billing.bill_run_account_stage` table + partition + the **UNIQUE `(run, ban, stage, attempt, period_partition)`** idempotency constraint + `StageStatus`/`ErrorClass` unions; the two session-less handlers `POST /api/billrun/[runId]/stage/[stage]/complete` and `.../status` (bearer constant-time compare, Zod, reject-unless-`PROCESSING`, 409-after-approval); the ingest service (insert stage row **first** → advance account → recompute run status under `SELECT … FOR UPDATE`) + heartbeat `last_progress_at` + counters-as-cache (stored == derived test); the **Validation** stage (per-account readiness gate); the `/bill-runs/[runId]` detail page shell + **Workflow** tab (`StageTimeline`, `StageStatusBadge`, `ErrorClassBadge`) + run → `PROCESSED`; the HARD/SOFT/INFRA failure taxonomy on the timeline.
- **Visible result:** the workflow (or a signed test caller) drives per-account stages that advance live on the detail page; replays are 200 no-ops; the run reaches `PROCESSED` with any failed accounts shown.
- **Depends on:** Unit 3; inbound bearer service token in Key Vault.

## Phase C — Draft bills & review

### Unit 5 — Draft bill generation (Claim + Aggregation)

- **Boundary:** `billing` schema + the `rating` charge boundary.
- **Builds:** the Postgres **grant** (`SELECT` on `rating.*`, `UPDATE` on only the claim-marker column of `rating.udr_rated`); `db/repositories/billing/rating-claim.ts` — the module's single `rating.*` writer (stamp `ref_bill_run_id` + `attempt`, never re-claim a claimed row); the **Collection/Claim** stage (auto-completes against the stub) and the retention/immutability contract test; `billing.customer_bill` table + partition + `CBL` seq + `BillCategory`/`BillState`; the **Aggregation** stage → `customer_bill` (`trial`, stamps `ref_bill_format_id`/`ref_bill_template_version_id`/`payment_due_date`, SQL-side money sums); the **Customers & Bills** tab (`CustomerBillTable` — per-account totals + charge lines read live from `rating.udr_rated`).
- **Visible result:** after processing, each account shows a draft (`trial`) bill with per-account totals and charge lines read from the rating store (no billing-side copy).
- **Depends on:** Unit 4; `rating.udr_rated` stub + role; `bill_template_version`/`bill_format` references (stamped).

### Unit 6 — Taxation

- **Boundary:** `billing` schema + detail read.
- **Builds:** `billing.customer_bill_tax_item` table + partition + `CBT` seq; the **Taxation** stage → tax lines + `tax_total`, stamped against the run's `ref_tax_rate_version`; tax display on the bill view (`BillCategoryBadge`, tax rows).
- **Visible result:** each draft bill shows its tax line items and tax total; the bill total reflects subtotal + tax.
- **Depends on:** Unit 5.

### Unit 7 — Verification, Uncharged & Errors tabs

- **Boundary:** `billing` services + detail read.
- **Builds:** the **Verification** stage → exception/finding rows; the **Uncharged** tab (`UnchargedTable` — partial-period/zero-charge accounts excluded at Scoping, with uncharged window + indicative value, CSV export, deep-link to Accounts → Transactions); the **Errors** tab (`ErrorsTable` — HARD failures with code/detail); the **Audit** tab (`AuditTable`) reading the module's audit events.
- **Visible result:** the run detail surfaces everything deliberately not charged (Uncharged), every blocking failure (Errors), and the action history (Audit) — each an explicit, exportable work queue.
- **Depends on:** Unit 6.

## Phase D — Correction, approval & posting

### Unit 8 — Rerun (full & partial)

- **Boundary:** `bill-runs` operate path.
- **Builds:** the rerun service + `rerun-run.action.ts` (`billrun_operate`): mandatory reason; **audit event written before re-trigger** (actor, accounts, prior totals, reason); per-account stage invalidation (discard outputs of stages > N for those accounts only); conditional trial re-derivation (`DELETE … WHERE ref_inv_document_id IS NULL` + re-aggregate); claim **release then re-claim** (refused for rows on a posted invoice); the absolute finalization guard; `RerunDialog` (preview + old→new total deltas, `attempt_count++`).
- **Visible result:** rerunning all or a selected subset from a chosen stage re-drives just those accounts, greys the invalidated later stages, and shows changed totals — with the reason captured first.
- **Depends on:** Unit 7 (a complete draft pipeline to re-derive).

### Unit 9 — Accounts-side INV & posting enablement _(cross-module — coordinate via the accounts plan)_

- **Boundary:** Accounts-owned `billing.document` / ledger objects (additive).
- **Builds:** `billing.document_inv_seq` + `'INV'` added to the document type CHECK; the **INV reason code** with an effectively unlimited `autoPostLimit` (so INV auto-posts); the GL mapping rows for the INV posting nature; the **period-close guard** (refuse to close a period while a run's postings map to it and it is not `COMPLETED`/`CANCELLED`).
- **Visible result:** an `INV` document can be created and auto-posted through the Accounts document engine (verifiable end-to-end), and closing a period is blocked while a run posts into it.
- **Depends on:** Unit 8 not required; needs the Accounts document engine + pgledger. Land it **just before** Approve, because Approve's pre-approval checks read GL mappings and period-open state.

### Unit 10 — Approve (four-eyes gate)

- **Boundary:** `bill-runs` approve path.
- **Builds:** the approve service + `approve-run.action.ts` (`billrun_approve`); the **four-eyes** check (approver ≠ final-attempt trigger actor) in the service layer; the **pre-approval checks** panel (`PreApprovalChecks` — accounting period open, GL mappings resolvable, no zero/negative totals, approver ≠ trigger actor, all accounts terminal, each pass/fail + remediation); stamping `approved_by`/`approved_at`/immutable `total_amount`; the `ApproveAndPostPage`/`ApproveAndPostPanel` with self-approval blocked in the UI and irreversibility framing; failed/excluded accounts recorded `SKIPPED`; run → `APPROVED`.
- **Visible result:** a **different** approver opens Approve & Post, sees the checklist, and approves — the run moves to `APPROVED`; the trigger actor is blocked from approving.
- **Depends on:** Unit 9 (GL mappings + period state for the checks); Unit 7.

### Unit 11 — Post to the ledger

- **Boundary:** `bill-runs` posting + Accounts document engine integration.
- **Builds:** the posting service + `post-run.action.ts` (`billrun_approve`), **per account in its own transaction**: read the claimed `rating.udr_rated` rows for `(run, ban, posted_attempt)`, compute `charge_checksum`, create + auto-post one `INV` via `postDocument(tx, …)` (`ban.A/R ← revenue` + tax legs, `event_at = gl_event_at`), consume the invoice number, stamp `customer_bill.ref_inv_document_id`/`posted_attempt`/`charge_checksum`/`category='normal'`, account → `INVOICED`; resumable/idempotent (skip accounts already carrying `ref_inv_document_id`); `PERIOD_CLOSED` as a first-class per-account error with Retry; the `PostingProgressView`; run → `INVOICED`, then the v1 `DISTRIBUTING` no-op → `COMPLETED`; next-cycle operability keyed off `INVOICED`.
- **Visible result:** approving posts one INV per billed account (resumable on failure, skipped accounts consume no number), the posting-progress view tracks it, and the run reaches `INVOICED` → `COMPLETED` while the next cycle becomes operable.
- **Depends on:** Unit 10; Unit 9 (INV seq/type/reason code, GL mappings, period-close guard).

## Phase E — Recovery & sign-off

### Unit 12 — Stall detection & recovery

- **Boundary:** `bill-runs` operate path + engine reconcile.
- **Builds:** derived **STALLED** display (computed from `PROCESSING` + stale `last_progress_at` vs the cycle threshold — never persisted); the `StallBanner`; **Check status** (reconcile against the engine's execution-status endpoint) and **Cancel run** (`cancel-run.action.ts`, `billrun_operate`: kill the execution, → `CANCELLED`, reset accounts to `PENDING`, clear `workflow_execution_id`, audited, consumes no invoice numbers; re-materializes the period cleanly).
- **Visible result:** a run with no heartbeat past its threshold shows STALLED; the operator reconciles or cancels, releasing the cycle.
- **Depends on:** Unit 4 (heartbeat + ingest); Unit 3 (execution reference).

### Unit 13 — End-to-end journey & ship gate

- **Boundary:** tests / CI.
- **Builds:** the full route × level authorization matrix for the three pages + both M2M handlers; the module guardrail tests (`billmgmt-code-standards.md` §9: authz + four-eyes split, M2M auth/replay/409, claim correctness, finalization latch, no charge copy, partition/idempotency, state machine, posting/GL integrity, stub isolation, audit); one E2E happy-path journey (materialize → trigger → process → review → rerun subset → approve → post → complete); SAST + OWASP ZAP DAST baseline green.
- **Visible result:** the complete operator journey passes end-to-end and the ship gate is green with no high/critical finding.
- **Depends on:** Units 1–12.

---

# Part 2 — Phase 2 (Units 14–21) — NEW THIS SESSION

> Workflow-management wiring, rendering & distribution. Source: `_updatemodule-billing-billrun-phase2-plan.md` (+ decisions §15), `billmgmt-update-overview.md`, `billmgmt-architecture.md` phase-2 §1/§4/§6. These units rewire the pipeline to run in the `billrun` Kestra engine (**B-fat** — the worker writes bill-data as `billrun_runtime`), move the M2M handler to **record-only**, and add **reject**, **rendering**, and **distribution**. Phase-1 file/naming conventions are as-built (`.repository.ts`, `services/billing/read/`, `EXCLUDED` account status, **no `rating` table was built in Phase 1** — Phase 2 introduces it).

## Phase F — Engine boundary & charge source

### Unit 14 — `billrun_runtime` role & the two-writer grant boundary

- **Boundary:** `db/bootstrap/**` (billing-owned).
- **Builds:** `db/bootstrap/billrun-db-roles.sql` (D15) — `CREATE ROLE billrun_runtime` (login, connection limit, Key Vault password); `GRANT CONNECT` on the billing DB; column-scoped `INSERT`/`UPDATE`/`SELECT` on `customer_bill` + `customer_bill_tax_item`; column-scoped `UPDATE` on the six `udr_rated` claim columns (+`SELECT`); explicit `REVOKE`s on `bill_run*` / `billing.document` / the pgledger `SECURITY DEFINER` fns (incl. from `PUBLIC`); **no grant on the `kestra` DB**. Runs **after** the rating bootstrap.
- **Visible result:** the grant guardrail passes — `billrun_runtime` writes only the two bill-data tables + the six claim columns and is refused (asserted per column/table) everywhere else; it holds `CONNECT` on billing only via its explicit grant and is refused the `kestra` DB.
- **Depends on:** rating `rating.udr_rated` schema (rm01) + the `PUBLIC`-revoke bootstrap (rm03); Phase-1 `customer_bill` / `customer_bill_tax_item`.

### Unit 15 — `_SAMPLE_*` `udr_rated` seed + placeholder-mode rename

- **Boundary:** `db/seeds/sample/**` + config/UI rename.
- **Builds:** `db/seeds/sample/seed-billrun-sample.ts` (D28/D32) — a billing-owned scenario composed from rating's `udr_rated` row-factory (sample BANs matching `_SAMPLE_*` accounts, the test run window, a few `BILL_NOTUSED` rows; rows carry `source_file='_SAMPLE_billrun'`), run via a prod-guarded `db:seed-sample`; the `STUB_DATA_MODE → BILLRUN_PLACEHOLDER_MODE` rename (D2/D3) and `StubDataBanner/StubBadge → PlaceholderBanner/PlaceholderBadge` with the new copy.
- **Visible result:** `db:seed-sample` populates real `_SAMPLE_*` `udr_rated` charge rows the pipeline can claim; every run carries the "Placeholder pipeline …" banner.
- **Depends on:** rating's exposed `udr_rated` row-factory (D28) + schema (rm01). _(Independent of Unit 14 — the seed runs as the table-owning seed role, not `billrun_runtime`.)_

## Phase G — B-fat processing rewire

### Unit 16 — Engine registry + `bill_run` two executions + `bill_run_processing` flow (placeholder) + M2M record-only

- **Boundary:** app (`services/billing/engine-registry.ts`, the M2M handler, a `bill_run` migration) **+ the external `bill_run_processing` flow**.
- **Builds:** `engine-registry.ts` resolving the `billrun` engine **by name** (per-engine creds; wraps the as-built `engine-client.ts`, D24); the `bill_run` migration adding `processing_execution_id` / `processing_flow_revision` / `distribution_execution_id` / `distribution_flow_revision` + the resolved **engine identity** (D23/D25e); the **external `bill_run_processing` flow** — per-account fan-out, placeholder stage tasks that **claim `RATED → BILL_DRAFT` and write `customer_bill` / `customer_bill_tax_item` as `billrun_runtime`**, then signal the app (**write-then-signal**, D6); the **M2M handler changed to record-only** (advance stage, heartbeat, recompute run status — no app-side stage compute, D5). Phase-1's app-side Validation / Aggregation / Taxation compute is retired to the flow.
- **Visible result:** triggering a run starts the **real Kestra processing execution**; per account the flow claims its seeded `udr_rated` (`RATED → BILL_DRAFT`), the worker writes the trial `customer_bill` + tax, the app **records** each stage, and the run reaches `PROCESSED` — the compute no longer runs in the app.
- **Depends on:** Unit 14 (role), Unit 15 (seeded `udr_rated`); a deployed `billrun` Kestra engine.

### Unit 17 — `udr_rated` approve/reject/release lifecycle + **Reject** action

- **Boundary:** app operate/approve path (`db/repositories/billing/udr-status.repository.ts`, actions, UI).
- **Builds:** `udr-status.repository.ts` — the app's **only** `rating.udr_rated` writer (approve `BILL_DRAFT → BILL_APPROVED`, reject `BILL_DRAFT → REJECTED`, release on cancel/rerun), column-scoped, never `INSERT`; the **Reject** action + `RejectDialog` (`billrun_approve`, D12) sending the whole bill or selected accounts back to reprocess; wiring approval to flip `BILL_APPROVED`, cancel/rerun to release; reprocess re-claims in-scope `RATED` / `REJECTED`.
- **Visible result:** approving flips the run's claimed rows to `BILL_APPROVED`; **rejecting** flips them to `REJECTED` and returns the run to a reprocessable state; a reprocess re-claims them to `BILL_DRAFT`; reject is refused once `BILL_APPROVED`/posted.
- **Depends on:** Unit 16 (the `BILL_DRAFT` claim exists); Phase-1 approve (Unit 10), cancel + rerun (Units 8, 12).

## Phase H — Money outputs (rendering & distribution)

### Unit 18 — Rendering foundation + draft PRO-FORMA preview

- **Boundary:** app rendering (`services/billing/render-invoice.ts`, component) + the app runtime image.
- **Builds:** Playwright / headless **Chromium baked into the app runtime image** (D17); `render-invoice.ts` **draft mode** — watermarked "DRAFT · PRO-FORMA · NOT A VALID INVOICE", no invoice number, **ephemeral (never stored)**, one throwaway HTML/CSS template (D18); `InvoicePreviewModal`, on-demand from Customers & Bills.
- **Visible result:** a reviewer opens an account and **previews a draft PRO-FORMA invoice** (real PDF, watermarked, streamed, not stored); a rerun/reject leaves no artifact.
- **Depends on:** Unit 16 (a trial `customer_bill` to render).

### Unit 19 — Posting on real charges + final render + store

- **Boundary:** app posting + rendering + `billing` schema + Azure Blob.
- **Builds:** `billing.bill_run_invoices` table (+ `pg_partman` partition, 7-year) + `bill-run-invoices.repository.ts`; the **Blob `invoices/` archive** (Azurite in dev) + lifecycle policy; `render-invoice.ts` **final mode** (immutable, stored, checksum); `post-run.ts` reads each account's **claimed `udr_rated`** by `(run, ban, posted_attempt)` and computes `charge_checksum` over the **real** rows (replacing the Phase-1 synthetic stub), then **renders + stores** the final invoice PDF right after each account's INV commits (a separate step — a render failure never rolls back a posted INV, D10); `StoredInvoiceModal` (download).
- **Visible result:** approving + posting reads each account's real seeded charges, posts one `INV`, and **stores an immutable, checksummed final invoice PDF** in `bill_run_invoices` (downloadable); the run reaches `INVOICED`.
- **Depends on:** Unit 17 (`BILL_APPROVED`), Unit 18 (the renderer), Unit 14 (`udr_rated` read grant); Phase-1 posting (Unit 11).

### Unit 20 — Distribution flow + `bill_run_distribution` + Distribution tab

- **Boundary:** app (`services/billing/distribute-run.ts`, action, `DistributionTab`, schema) **+ the external `bill_run_distribution` flow**.
- **Builds:** `billing.bill_run_distribution` table (+partition) + repository; the **external `bill_run_distribution` flow** — transport-only, one **loopback** target with a forceable-failure switch (D20); `distribute-run.ts` — the app triggers **execution #2** at `INVOICED` and reconciles per-target outcomes; the **`DistributionTab`** (targets + per-artifact delivery log); the `INVOICED → DISTRIBUTING → COMPLETED` and `DISTRIBUTION_FAILED → rerun-distribution` transitions (rerun-distribution is `billrun_operate`).
- **Visible result:** after posting, a **separate distribution execution** delivers the stored artifacts to the loopback target and logs per-target outcomes → `COMPLETED`; a forced mandatory-target failure → `DISTRIBUTION_FAILED`, rerunnable **without touching posted INVs**; the next cycle stays operable at `INVOICED`.
- **Depends on:** Unit 19 (stored artifacts to deliver), Unit 16 (registry + execution columns).

## Phase I — Sign-off

### Unit 21 — Phase-2 ship gate

- **Boundary:** tests / CI.
- **Builds:** the phase-2 guardrail suite (`billmgmt-code-standards.md` §9 additions — the two-writer boundary asserted per column/table, the `udr_rated` lifecycle, rendered-invoice integrity, distribution, two-execution + engine-registry, placeholder isolation) against a live DB; one **phase-2 E2E** — `db:seed-sample` → trigger → Kestra `bill_run_processing` → `PROCESSED` → draft preview → **reject → reprocess** → approve → post → render+store → **distribute** → `COMPLETED`; SAST + OWASP ZAP DAST green.
- **Visible result:** the full phase-2 operator journey passes end-to-end against seeded data and the ship gate is green with no high/critical finding.
- **Depends on:** Units 14–20.

---

## Build-order summary

| #   | Unit                                                                            | Boundary                       | Key just-in-time dependency introduced                                     |
| --- | ------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| 1   | Billing section & RBAC scaffold                                                 | auth/RBAC + shell              | `billrun_*` perms, Billing Viewer role                                     |
| 2   | Bill Runs list + lazy materialization                                           | `billing` schema + read        | `bill_run` table; stub-mode flag                                           |
| 3   | Trigger (+ Scoping + outbound engine)                                           | operate + outbound M2M         | `bill_run_account` (+partition); engine client                             |
| 4   | M2M ingest + stage timeline                                                     | M2M handlers + detail read     | `bill_run_account_stage` (+UNIQUE); inbound token                          |
| 5   | Draft bill generation (Claim + Aggregation)                                     | `billing` + `rating` boundary  | rating grant; `customer_bill` (+partition)                                 |
| 6   | Taxation                                                                        | `billing` + read               | `customer_bill_tax_item` (+partition)                                      |
| 7   | Verification, Uncharged & Errors tabs                                           | services + read                | — (surfaces existing rows)                                                 |
| 8   | Rerun (full & partial)                                                          | operate                        | —                                                                          |
| 9   | Accounts-side INV & posting enablement                                          | Accounts document/ledger       | `document_inv_seq`, INV type/reason, GL maps, period-close guard           |
| 10  | Approve (four-eyes)                                                             | approve                        | —                                                                          |
| 11  | Post to the ledger                                                              | posting + document engine      | INV posting via `postDocument`                                             |
| 12  | Stall detection & recovery                                                      | operate + reconcile            | engine status/kill endpoints                                               |
| 13  | End-to-end journey & ship gate                                                  | tests / CI                     | —                                                                          |
| —   | **— Phase 2 (new this session) —**                                              |                                |                                                                            |
| 14  | `billrun_runtime` role & two-writer grant boundary                              | `db/bootstrap`                 | `billrun_runtime` role + column-scoped grants (D15)                        |
| 15  | `_SAMPLE_*` `udr_rated` seed + placeholder-mode rename                          | `db/seeds/sample` + config/UI  | seeded charge source; `BILLRUN_PLACEHOLDER_MODE`                           |
| 16  | Engine registry + two executions + `bill_run_processing` flow + M2M record-only | app + external flow            | engine registry; `bill_run` exec columns; the real processing flow (B-fat) |
| 17  | `udr_rated` approve/reject/release lifecycle + Reject                           | app operate/approve            | `udr-status.repository.ts`; Reject action                                  |
| 18  | Rendering foundation + draft PRO-FORMA preview                                  | app rendering + runtime image  | Playwright/Chromium; `render-invoice.ts` (draft)                           |
| 19  | Posting on real charges + final render + store                                  | app posting + rendering + Blob | `bill_run_invoices` (+partition); Blob `invoices/`; final render           |
| 20  | Distribution flow + `bill_run_distribution` + tab                               | app + external flow            | `bill_run_distribution`; loopback target; distribution execution           |
| 21  | Phase-2 ship gate                                                               | tests / CI                     | —                                                                          |

**Notes (Phase 1)**

- Units 5–7 are the pipeline stages surfaced with their review UI; **Claim is merged into Unit 5** (no standalone visible result), while **Taxation (6)** and **Verification (7)** stay separate because each adds a distinct, demoable surface.
- **Scoping is merged into Trigger (3)** — it runs app-side before the workflow and has no result separate from a triggered run.
- **Unit 9 is cross-module**: it changes Accounts-owned objects and must be coordinated through the accounts plan and proven not to change existing Accounts behaviour (`billmgmt-ai-workflow-rules.md` §3.6). It is sequenced just before Approve because Approve's checks are its first consumer.
- _(As-built)_ Phase 1 shipped with **no `rating` table** — Collection is an app-computed no-op and bill totals are a deterministic synthetic stub; the account status union gained a 10th member `EXCLUDED` (border-case scoping exclusion). Phase 2 supersedes both.

**Notes (Phase 2)**

- **Rendering and Distribution are no longer out of scope** — Phase 2 builds mock-content rendering (Units 18–19) and a loopback distribution execution (Unit 20); `DISTRIBUTING` is now entered for real. The **production template system, real distribution targets, per-run `bill_run_output`, real billing compute, and the live rating pipeline stay out of scope** (`_updatemodule-billing-billrun-phase2-plan.md` §Out-of-scope, §15 D16–D22).
- **Unit 16 is the centerpiece and spans two boundaries** (app + the external Kestra flow) — merged because the app-side plumbing (registry, exec columns, record-only handler) has **no standalone visible result** without the flow that drives it; testing either half alone proves nothing (same rationale as rating's flow-template unit).
- **Units 14 & 15 are cross-module-coordinated** with the rating module (the `billrun_runtime` bootstrap runs after rating's `PUBLIC`-revoke, D15; the seed calls rating's `udr_rated` row-factory, D28) — decisions, not blockers; each leaves only a build/coordination task (§15 §L).
- **`bill_run_invoices` lands in Unit 19, not 18** — draft renders are ephemeral (never stored), so the table + Blob store are introduced just-in-time when the _final_ stored invoice first needs them.
- **Reject (17) reuses the release machinery** — approve/cancel/rerun already existed (Phase 1); Unit 17 adds the `udr_rated` lifecycle writes on top and the one new approver action.
