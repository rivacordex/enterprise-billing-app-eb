# bm37 — Local End-to-End Assertion + Reconcile Alignment

**Unit:** bm37 (Phase 4 · Phase O). **Boundary:** `scripts/billrun-live-kestra-smoke.ts` + `services/billing/reconcile-run.ts` (assertions/alignment only, app repo). **No flow change** — bm36 owns the processing flow, bm34 owns distribution. **Specs from:** `billmgmt-update-overview.md` (Phase 4 goals 3–5; distribution = "unverified, not unbuilt"; failure-settlement decision), `billmgmt-gap-assessment.md` (§7 acceptance criteria 1–6, §2 evidence), `bm00-build-plan.md` Unit 37. **Model:** the delivered smoke (`materialize → trigger → poll reconcileRun until PROCESSED`, bm21) + the delivered E2E journey (`billing-e2e-happy-path.integration.test.ts`).

> **Framing.** bm36 makes a run reach `PROCESSED` on its own; this unit proves the **whole** journey works end-to-end against the real local stack and closes the bm16/bm20 live-Kestra gate that has been open since Phase 2 for want of signal-back. The delivered smoke stops at `PROCESSED`; it must now drive the operator path (reject → reprocess → approve → post → distribute) through to `COMPLETED`, assert a HARD-failing account settles to `PROCESSING_FAILED` via the terminal signal (using bm36's `BILLRUN_PROCESSING_FORCE_FAIL`), assert distribution's forced-failure → rerun → `COMPLETED`, and confirm the stall/reconcile gate no longer fires on a healthy run. Distribution here is **unverified, not unbuilt** (bm34 is real) — the work is reaching and asserting it, not new distribution code.

## Goal

Extend the live-Kestra smoke to drive and assert the full `SCHEDULED → COMPLETED` lifecycle on the `_SAMPLE_` `ci` seed — including reject → re-rate → reprocess, a force-failed account settling to `PROCESSING_FAILED`, and distribution with a forced mandatory failure → rerun — and confirm reconcile/stall integrity, so a single command proves the module completes end-to-end locally.

## Design

**Structural decisions**

- **Extend the existing script, keep its safety gate absolute.** The `_SAMPLE_`-only three-condition gate (scoped accounts all belong to `_SAMPLE_-BILLRUN-0001`; every candidate `udr_rated` charge carries the `_SAMPLE_` provenance markers; refuses the STUB engine via `isBillRunEngineConfigured`) stays and **extends to cover the new mutating steps** (approve/post consume invoice numbers) — the script must still abort before any write if the target is not the seeded sample customer.
- **Drive the operator path through the same service functions the app uses**, not a parallel copy: `materializeDueRuns` → `triggerRun` → poll `reconcileRun` to `PROCESSED` (existing) → `rejectRun` → `rerunRun` (rejected accounts) → poll to `PROCESSED` → `approveRun` (a **second** `_SAMPLE_` actor, for four-eyes ≠ the trigger actor) → `postRun` → `INVOICED` → `triggerDistribution` → poll `reconcileRun`/outcomes → `rerunDistribution` (after the forced failure) → `COMPLETED`.
- **Two runs, sequenced, so each assertion is clean.** **Run A (happy + reject + distribution-failure legs):** with `BILLRUN_DISTRIBUTION_FORCE_FAIL=true` for the first distribution attempt → `DISTRIBUTION_FAILED` → `rerunDistribution` (force-fail off) → `COMPLETED`. **Run B (processing-failure settlement leg):** the next due period with `BILLRUN_PROCESSING_FORCE_FAIL=true` → poll → assert the forced account reaches `PROCESSING_FAILED` and the run recomputes to `PROCESSING_FAILED` (rerunnable) via the **terminal signal**, not the stall timeout; then `rerunRun` (force-fail off) recovers it to `PROCESSED`. Keeping the two failure injections in separate runs avoids one run being simultaneously reject-blocked and processing-failed.
- **Reconcile alignment, asserted both ways.** On the healthy Run A, assert `reconcileRun` returns `mismatch: false` and `isStalled(run, now)` is `false` while signals flow (the gate must not fire on a run that is progressing). For the genuinely-wedged case, assert the existing guarantee holds: a `SUCCESS` engine state with a non-terminal account grain yields `mismatch: true` with **no forced status and no heartbeat bump** (`reconcile-run.ts` lines 115–138) — exercised by withholding one account's signal (force-fail off but drop a signal) or by a targeted unit assertion, so the gate still catches a real wedge.
- **Fail loud, change nothing on assertion failure.** Any unexpected status, timeout, or a non-`_SAMPLE_` target throws; the script is read-mostly except the sanctioned operator writes against the sample customer.

## Implementation

### 1. Extend the poll-and-drive loop (Run A)

After the existing `reconcileRun` loop reaches `PROCESSED`, continue:
1. **Reject leg:** `rejectRun({billRunId, scope: 'selected', banIds: [oneBilledSampleBan], reason})`; assert the run stays `PROCESSED`, the account's trial bill is deleted, the `REJECTED_PENDING_REPROCESS` marker is set (`listRejectedPendingForRun`), and `approveRun` is blocked (`CHECKS_FAILED` / `no_rejected_pending`).
2. **Reprocess:** `rerunRun` the rejected account from `validation`; poll `reconcileRun` back to `PROCESSED` with the marker cleared.
3. **Approve (four-eyes):** `approveRun` as a second seeded `_SAMPLE_` actor ≠ the trigger actor; assert `APPROVED`.
4. **Post:** `postRun`; assert one `INV` per billed account, `INVOICED`, next-cycle operability.
5. **Distribute (forced failure):** with `BILLRUN_DISTRIBUTION_FORCE_FAIL=true`, `triggerDistribution`; poll `reconcileRun` (DISTRIBUTING branch) / outcomes to `DISTRIBUTION_FAILED`; then `rerunDistribution` (flag off) and poll to `COMPLETED`.

### 2. Processing-failure settlement (Run B)

Materialize/trigger the next due `_SAMPLE_` period with `BILLRUN_PROCESSING_FORCE_FAIL=true`; poll `reconcileRun`; assert the forced account is `PROCESSING_FAILED` and the run recomputes to `PROCESSING_FAILED` (the terminal signal did it — assert before any stall threshold could elapse); then `rerunRun` (flag off) recovers to `PROCESSED`. Optionally carry Run B on to `COMPLETED` to prove recovery end-to-end.

### 3. Reconcile alignment

- Assert `reconcileRun` on the healthy Run A never returns `mismatch: true` and never leaves a `PROCESSED`/`COMPLETED` run flagged `STALLED`.
- Assert the wedge guarantee: a `SUCCESS` engine state with a non-terminal account grain yields `mismatch: true`, no forced status, no heartbeat bump (so `StallBanner` still surfaces a real wedge). Keep `reconcile-run.ts` behaviour unchanged — this unit asserts it, and only touches it if the assertion surfaces a genuine gap.

### 4. Script ergonomics

Keep `npm run billrun:live-kestra-smoke` as the entry point; update its final success log to state the full `SCHEDULED → COMPLETED` journey (incl. reject and both forced-failure paths) was proven, superseding the "trigger → claim → PROCESSED" message.

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm36 (a run reaches `PROCESSED` on its own, and `BILLRUN_PROCESSING_FORCE_FAIL` exists); the provisioned local stack (docker Kestra + app + Azurite + local SFTP/loopback, 2026-09-11); the `ci` seed (bm26) with a second `_SAMPLE_` actor available for four-eyes; real distribution (bm34) and `BILLRUN_DISTRIBUTION_FORCE_FAIL` (bm20/bm33).

## Verification checklist

- [ ] `npm run billrun:live-kestra-smoke` drives Run A `SCHEDULED → COMPLETED` on the `_SAMPLE_` `ci` seed: `PROCESSED` (via bm36 signals) → reject a subset (marker set, approval blocked) → rerun-rejected → `PROCESSED` → approve (four-eyes, second actor) → post (`INV` per account) → `INVOICED` → distribute (forced fail → `DISTRIBUTION_FAILED` → `rerunDistribution` → `COMPLETED`).
- [ ] Run B asserts a HARD-failing account reaches `PROCESSING_FAILED` via the **terminal signal** (before any stall threshold), the run recomputes to `PROCESSING_FAILED` (rerunnable), and `rerunRun` (force-fail off) recovers it to `PROCESSED`.
- [ ] `reconcileRun` returns `mismatch: false` and `isStalled` is `false` on the healthy run; a `SUCCESS`-but-non-terminal grain still yields `mismatch: true` with no forced status / no heartbeat bump.
- [ ] The `_SAMPLE_`-only safety gate still aborts before any write (trigger, approve, post) when the target is not the seeded sample customer or a candidate charge is not `_SAMPLE_`-marked; the script still refuses the STUB engine.
- [ ] The bm16/bm20 live-Kestra gate is recorded closed for local; `tsc`/lint/tests green; `billmgmt-progress-tracker.md` records bm37.
