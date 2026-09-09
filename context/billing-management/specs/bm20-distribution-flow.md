# bm20 — Distribution Flow + `bill_run_distribution` + Distribution Tab

**Unit:** bm20 (Phase 2 · Phase H). **Boundary:** app (`services/billing/distribute-run.ts`, a third M2M handler, `bill_run_distribution` schema/repo, `DistributionTab`, schema) **+ the external `bill_run_distribution` flow** (template skeleton here; real flow in the separate repo). **Specs from:** `_updatemodule-billing-billrun-phase2-plan.md` §3/§7/§15 **D8/D9/D20/D21/D23**, `billmgmt-architecture.md` §5, `bm00-build-plan.md` Unit 20.

> **Framing.** This is the **bill run distributor** — the workflow management component's third function. It is **transport-only** (D-push): the app rendered/stored the artifacts (bm19); the distributor only delivers them to targets and signals outcomes. It runs as a **second execution**, after posting.

## Goal

After a run reaches `INVOICED`, have the app trigger the `bill_run_distribution` execution, which delivers the run's stored artifacts (invoice PDFs + a per-run report) to configured targets — one **loopback** target this phase — and signals per-artifact outcomes the app records in `bill_run_distribution`, driving `INVOICED → DISTRIBUTING → COMPLETED` (all mandatory landed) or `DISTRIBUTION_FAILED → rerun-distribution` (a mandatory-target failure), **without ever touching a posted INV** and without blocking the next cycle.

## Design

**Structural decisions**

- **A separate, second execution the app triggers at `INVOICED` (D8/D9).** Phase-1 posting went `POSTING → COMPLETED` (DISTRIBUTING never entered). Phase 2: `POSTING → INVOICED`, then — automatically, once — the app triggers `bill_run_distribution` and moves `INVOICED → DISTRIBUTING`; on all mandatory artifacts landing → `COMPLETED`. **Next-cycle operability still keys off `INVOICED`**, so a stuck distribution never holds up next month (Inv #16-equivalent).
- **Transport-only, D-push.** The app hands the flow **references** to the already-stored artifacts (`bill_run_invoices.blob_ref`s + a per-run report). The flow delivers; it computes/renders nothing.
- **One loopback target, forceable failure (D20).** The loopback target echoes each artifact back to a store location and records an outcome — `is_mandatory=true`, with a switch to force a failure so `DISTRIBUTION_FAILED → rerun-distribution` is exercised. Real targets (portal, AR feed, statutory, email) stay out of scope; the advisory (non-blocking) path exists in the state machine but has no configured target.
- **A sanctioned third M2M handler (architecture decision).** Code-standards §5 fixes the M2M surface at two handlers and says a third needs a decision — this is that decision. Add `POST /api/billrun/[runId]/distribution/outcome` (service-token, session-less): records **one per-artifact-per-target outcome** into `bill_run_distribution`; the existing `.../status` endpoint carries the distribution execution's **terminal** push (which recomputes the run to `COMPLETED`/`DISTRIBUTION_FAILED`). The bm13 route-inventory test updates to admit exactly these **three** `POST` handlers.
- **Outcomes are app-written; the flow only signals.** `billrun_runtime` has no grant on `bill_run_distribution` (bm14) — it is run-state, app-owned. The flow signals; the app writes the outcome rows and recomputes the run.
- **The per-run report is a transient payload, not a stored record (D21).** `distribute-run.ts` generates a per-run invoice-register **CSV** at distribution-prep, writes it to the blob store as a distribution payload, and delivers it as one artifact — but it gets **no** `bill_run_output` row (that table stays deferred). Only per-account invoice PDFs are persisted (bm19).

## Implementation

### 1. `db/schema/billing/bill-run-distribution.ts` + migration + repository

- Table `billing.bill_run_distribution` (partitioned on `period_partition` via `pg_partman`, like the record tables): `bill_run_distribution_id` PK (`BRD`+8 seq), `ref_bill_run_id`, `target` (e.g. `'loopback'`), `artifact_ref` (a `bill_run_invoice_id` or the report key), `artifact_type` (`'invoice_pdf'|'report_csv'`), `is_mandatory` (bool), `outcome` (`'DELIVERED'|'FAILED'`), `at` (timestamptz), `distribution_attempt` (int — the redelivery round, bumped by `rerunDistribution`; T1), `period_partition`. Composite PK includes `period_partition`; **UNIQUE `(ref_bill_run_id, target, artifact_ref, distribution_attempt, period_partition)`** so a rerun's outcome is a fresh row, not a dropped replay (T1); register in `billing-partman-setup.sql`. App-owned (`app_runtime` write; `billrun_runtime` none).
- `bill-run-distribution.repository.ts` — insert outcome, list-for-run (the delivery log read model), summarise (delivered/failed counts).

### 2. `flows/billrun/bill_run_distribution.template.yml` (new — template skeleton, no logic)

```yaml
# TEMPLATE ONLY — no business logic. The real bill_run_distribution flow lives in
# the separate workflow-management repo. Transport-only (D-push): it delivers
# already-stored artifacts and signals outcomes; it renders/computes nothing.
id: bill_run_distribution
namespace: billrun
inputs:
  - { id: bill_run_id, type: STRING }
  - { id: artifacts, type: JSON } # [{ ref, type, blob_ref }, ...] — invoice PDFs + the report CSV
  - { id: targets, type: JSON } # [{ name: 'loopback', is_mandatory: true, force_fail: false }]
tasks:
  - id: per_artifact
    type: io.kestra.plugin.core.flow.ForEach
    values: "{{ inputs.artifacts }}"
    tasks:
      - id: deliver_loopback
        # STUB: read the artifact from blob and echo it back to the store location
        #       (loopback). If force_fail => FAILED, else DELIVERED. REAL: push to the
        #       actual target (portal / AR feed / statutory / email).
        #       On each artifact: POST .../distribution/outcome {target, artifact_ref,
        #       artifact_type, is_mandatory, outcome}.
errors:
  - id: on_error # STUB: POST terminal DISTRIBUTION_FAILED to .../status
finally:
  - id: on_finally # STUB: POST the terminal distribution status to .../status (Inv #1 obligation)
```

### 3. `services/billing/distribute-run.ts` (new)

- `triggerDistribution(runId)` — called when a run reaches `INVOICED` (from `post-run.ts` completion): gather the run's `bill_run_invoices` (blob refs) + generate the per-run register CSV → blob (transient); resolve the `billrun` engine (bm16 registry); trigger `bill_run_distribution` with `{bill_run_id, artifacts, targets}`; stamp `distribution_execution_id`/`_flow_revision`/`_engine_ref`; move `INVOICED → DISTRIBUTING`.
- `rerunDistribution(runId)` (`billrun_operate`) — re-trigger `bill_run_distribution` for the **failed** artifacts only (from `bill_run_distribution` where `outcome='FAILED'`); audited (`BILL_RUN_DISTRIBUTION_RERUN`).
- Run-status recompute for distribution: `DISTRIBUTING → COMPLETED` when every **mandatory** artifact is `DELIVERED`; `→ DISTRIBUTION_FAILED` when a mandatory artifact is `FAILED` (advisory failures listed, non-blocking).

### 4. M2M handlers

- New `app/api/billrun/[runId]/distribution/outcome/route.ts` — `POST`, service-token (constant-time), Zod-validate the outcome body, insert one `bill_run_distribution` row; idempotent on `(run, target, artifact_ref, distribution_attempt)` (replay → 200 no-op) — a rerun uses a **new** `distribution_attempt`, so its `DELIVERED` is a fresh row the recompute reads as the latest outcome, superseding the prior `FAILED` (T1); reject unless the run is `DISTRIBUTING`.
- Extend `.../status` to accept the distribution execution's terminal push (recompute to `COMPLETED`/`DISTRIBUTION_FAILED`, bump `last_progress_at`).
- Update the bm13 route-inventory test to lock the surface to **three** `POST` handlers (record the §5 architecture decision in `billmgmt-code-standards.md` §5).

### 5. `post-run.ts` — completion path change

- Replace the phase-1 `POSTING → COMPLETED` direct transition with `POSTING → INVOICED`, then call `distribute-run.triggerDistribution(runId)` (which enters `DISTRIBUTING`). `invoiced_at` stamped at `INVOICED`; `distributing_at`/`completed_at` stamped by the distribution path.

### 6. UI — `DistributionTab`

- `components/billing/distribution-tab.tsx` (new): the targets list (loopback mandatory; deferred targets greyed), the per-artifact **delivery log** (`bill_run_distribution` rows with `DistributionOutcome` badges, `billmgmt-ui-context.md` §6b), and — on `DISTRIBUTION_FAILED` — a **Rerun distribution** control (`billrun_operate`) with the "posted INVs untouched / next cycle already unblocked" framing. Add the tab to `run-detail-tabs.tsx`.

## Dependencies

- **No new npm packages** (blob client from bm19; engine registry from bm16).
- **Prerequisites:** bm19 (stored artifacts to deliver), bm16 (registry + execution columns + the M2M/record spine), bm14 (`billrun_runtime` has no `bill_run_distribution` grant).
- **External prerequisite:** the deployed **placeholder `bill_run_distribution` flow** (separate repo) built to §2's contract, on the `billrun` engine.

## Verification checklist

- [ ] `bill_run_distribution` exists (partitioned, app-owned; `billrun_runtime` refused); the third M2M handler records one outcome per `(run, target, artifact_ref, distribution_attempt)`, replay → 200, a rerun-attempt `DELIVERED` supersedes a prior `FAILED` so the run reaches `COMPLETED`, rejected unless `DISTRIBUTING`; the route-inventory test locks the surface to three `POST` handlers.
- [ ] A run at `INVOICED` **automatically** triggers `bill_run_distribution` (once), stamps the distribution execution columns, and enters `DISTRIBUTING`; next-cycle operability still keys off `INVOICED`.
- [ ] Against the deployed placeholder flow + `_SAMPLE_*` data: the loopback delivers each invoice PDF + the per-run report, per-artifact outcomes land in `bill_run_distribution`, all mandatory `DELIVERED` → the run reaches `COMPLETED`.
- [ ] A **forced** mandatory-target failure → `DISTRIBUTION_FAILED`; **Rerun distribution** (`billrun_operate`) re-delivers the failed artifacts and reaches `COMPLETED`, **without touching any posted INV**; an advisory failure does not block.
- [ ] `DistributionTab` shows targets + the per-artifact delivery log with correct badges, and the rerun control only on `DISTRIBUTION_FAILED`; a `billrun_view` viewer sees it read-only.
- [ ] The per-run report is a transient blob payload with a delivery-log row and **no** `bill_run_output` table.
- [ ] `tsc`/lint/tests green; `billmgmt-code-standards.md` §5 records the third-handler decision; `billmgmt-progress-tracker.md` updated (bm20 delivered).

## Phase-2 review folds (2026-08-28)

**T1 (P1, eng §16) — `distribution_attempt` in the idempotency key — applied inline in §1/§4.** The `bill_run_distribution` UNIQUE and the `.../distribution/outcome` handler now key on `(run, target, artifact_ref, distribution_attempt)` (the app bumps `distribution_attempt` per `rerunDistribution`); run-status recompute reads the **latest attempt** per `(target, artifact_ref)`, and the `report_csv` artifact participates in the same key. This closes the "stuck at `DISTRIBUTION_FAILED`" hole where a rerun's `DELIVERED` was dropped as a replay. Verification addition (§Verification): forced-fail → rerun-distribution supersedes the prior `FAILED` and reaches `COMPLETED`.

**T2 (P1, eng §16) — recover an `INVOICED` run whose distribution never started / stalled.** The inline `triggerDistribution` at `INVOICED` can be lost (app crash), and Inv #10 forbids a scheduler, so it can't self-heal; a wedged exec #2 has no reconcile path. Add:

- A `billrun_operate` **"Start distribution"** action for an `INVOICED` run with no `distribution_execution_id` (idempotent: re-derives artifacts, triggers exec #2, `ON CONFLICT`-guarded).
- Extend the bm12 derived-`STALLED` + reconcile/cancel path to a wedged `DISTRIBUTING` execution. Verification addition: killing the app between the `INVOICED` commit and the trigger leaves a run an operator can restart; a stalled exec #2 is reconcilable.

**T11 (P1, eng §16) — force-complete / abandon-distribution terminal path.** Post-`INVOICED` a run can't cancel (D11) and only completes when every mandatory artifact delivers, so a permanently-failing loopback holds the GL period open forever (Inv #13). Add a `billrun_approve` **force-complete** action: `DISTRIBUTION_FAILED → COMPLETED`, audited (`BILL_RUN_DISTRIBUTION_ABANDONED`, mandatory reason), posted INVs untouched, failed artifacts recorded abandoned. Decouples GL close from transport success. Verification addition: a permanently-failing mandatory target can be force-completed; the GL period then closes.

**D-T1 (P2, design §17) — control hierarchy on the Distribution tab.** Design the three state-dependent controls with the one-way action subordinate:

- `INVOICED`, no execution → a **primary "Start distribution"** (T2).
- `DISTRIBUTION_FAILED` → **"Rerun distribution"** primary/emphasized (the happy path); **"Force-complete / abandon"** a quiet, low-emphasis secondary that opens a **spelled-out danger-role confirm modal** (mandatory reason, lists the abandoned artifacts, states "the GL period will close and undelivered invoices are marked abandoned" — mirrors the Reject dialog). Never a peer button to Rerun. Verification addition: force-complete is never a bare/peer button; it always routes through the danger confirm.

**D-T3 (P2, design §17) — specify all four Distribution-tab states.** Today only `DISTRIBUTION_FAILED` is designed. Add:

- **INVOICED-pending:** money-posted banner + the "Start distribution" primary (the home for T2).
- **DISTRIBUTING (in-flight):** live delivery log filling + a `COMPLETED`-pending timeline node.
- **COMPLETED:** all-green delivery log, calm success summary, no actions.
- **DISTRIBUTION_FAILED:** existing.
  Each carries orientation + the right (or no) action. Verification addition: a completed run shows an all-green log + success summary, never a stale `DISTRIBUTING` or an empty table.
