# bm12 — Stall detection & recovery — Spec

**Unit:** bm12 (`bm00-build-plan.md`). **Boundary:** `bill-runs` operate path + engine reconcile. **Depends on:** bm04 (heartbeat `last_progress_at`, ingest), bm03 (engine client, `workflow_execution_id`).
**Grounded in** `F:/Projects/enterprise-billing-app/`: the engine client (bm03, mockable), `lib/config.ts`, the action→dialog→service(txn)→`insertAuditEvent`→`revalidatePath` template, `getAppTimezone`/`lib/timezone.ts`.

> **Two small defaults (say if you'd rather change):** (1) the **stall threshold** is a **global config** `BILLRUN_STALL_THRESHOLD_MINUTES` (default `30`) — the plan floats a per-cycle threshold, but there is no cycle column for it, so v1 uses one config value; (2) **Cancel** sets the run `CANCELLED` and makes it **re-triggerable** (the bm03 trigger guard is extended to allow trigger from `CANCELLED`, re-snapshotting fresh) — so "re-materialize the period cleanly" is a re-trigger of the same run row (the `(cycle, period_start)` unique key prevents a second row).

---

## Goal

A run left without a heartbeat past its stall threshold **displays** as `STALLED` (derived, never stored); the operator can **Check status** (reconcile against the workflow engine's execution-status endpoint) or **Cancel run** (kill the execution, set `CANCELLED`, reset accounts to `PENDING`, clear the execution reference, audited) — cancellation consumes no invoice numbers and leaves the period cleanly re-triggerable.

---

## Design

### Structural
- **`STALLED` is derived on read, never persisted** (architecture Inv. #10). A run is *shown* stalled when `status = 'PROCESSING'` and `now() − last_progress_at > BILLRUN_STALL_THRESHOLD_MINUTES`. Computed in one pure helper `services/billing/stall.ts` (`isStalled(run, now, thresholdMinutes)`), used by the read model — no background job writes it, no DB column.
- **Engine client gains two methods** (bm03 `EngineClient`): `getExecutionStatus(executionId): Promise<ExecutionStatus>` and `killExecution(executionId): Promise<void>`. Real impls call the engine's status/kill endpoints (Basic-Auth); the **stub** returns a synthetic status (`{ state: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'KILLED' }`) and a no-op kill. **The paths must be verified against the deployed engine version before wiring the real impl** (plan §13 open item) — flagged in code.
- **Check status** `services/billing/reconcile-run.ts`: query the engine for `workflow_execution_id`'s ground truth; reconcile — if the engine reports terminal (SUCCESS/FAILED) but the app is still `PROCESSING`, push the run to the correct state (or surface the mismatch); bump `last_progress_at`. Read-only to the ledger; no invoice numbers touched.
- **Cancel run** `services/billing/cancel-run.ts`, one `db.transaction`: `SELECT … FOR UPDATE` the run → guard (only a `PROCESSING`/`STALLED`-derived run) → `killExecution` (best-effort; a failed kill still lets cancel proceed with a logged warning) → set run `CANCELLED`, reset its `bill_run_account` rows to `PENDING`, clear `workflow_execution_id`, `insertAuditEvent(BILL_RUN_CANCELLED)`. **Consumes no invoice numbers** (nothing posted). The run stays on `(cycle, period_start)` and is re-triggerable (bm03 guard extended to `CANCELLED`).
- **Layer-3 escape** (plan §9): because the double-trigger guard keys off `status = 'PROCESSING'`, a wedged execution would otherwise block the cycle permanently — `CANCELLED` is the mandatory escape hatch.

### Visual (`billmgmt-ui-context.md` §4)
- **`StallBanner`** — a derived-state **Warning**-family banner on the run detail when `isStalled`; copy explains why (no heartbeat since {time}), with **Check status** (primary) and **Cancel run** (secondary, danger, inside a spelled-out confirm dialog). Never a stored `STALLED` pill.
- After Check status: a toast reports the reconciled state. After Cancel: the run shows `CANCELLED`, accounts `PENDING`, and the operable "Run" affordance returns.

---

## Implementation

### 1. Config — `lib/config.ts`
`BILLRUN_STALL_THRESHOLD_MINUTES: z.coerce.number().int().min(1).default(30)`; `.env.example` documents it.

### 2. Engine client — extend `services/billing/engine-client.ts`
Add `getExecutionStatus`/`killExecution` to the interface + real + stub impls. Flag "verify endpoint paths against the deployed engine" in the real impl.

### 3. Stall helper + reconcile + cancel services
`services/billing/stall.ts` (pure `isStalled`), `reconcile-run.ts`, `cancel-run.ts` (the transaction above). Framework-agnostic.

### 4. Actions + audit — `actions/billing/{check-status,cancel-run}.action.ts`
`'use server'`, `requirePermission(PERMISSIONS.BILLRUN_OPERATE, LEVELS.EDIT)` → service → `revalidatePath`. Add `BILL_RUN_CANCELLED` (and `BILL_RUN_RECONCILED` if you want the check audited) to `AUDIT_EVENT_TYPES` + `AUDIT_EVENT_CATEGORY_MAP` (+ coverage test).

### 5. Components — `components/billing/stall-banner.tsx` + cancel dialog
`StallBanner` (derived), `CancelRunDialog` (spelled-out confirm). Wire into the run detail header/`RunActionCard`.

### 6. bm03 trigger guard extension
Allow trigger from `CANCELLED` (re-snapshot fresh, new `attempt` sequence) — a one-line addition to the bm03 double-trigger guard's allowed-from set (`SCHEDULED` | `CANCELLED`).

### 7. Tests — `tests/…`
- `isStalled` unit tests (just-under vs just-over the threshold; non-`PROCESSING` never stalled); `STALLED` is never written to the DB.
- Check status reconciles a run whose engine state diverged; bumps `last_progress_at`; touches no invoice numbers.
- **Cancel** sets `CANCELLED`, resets accounts to `PENDING`, clears `workflow_execution_id`, writes `BILL_RUN_CANCELLED`, consumes no invoice numbers; a failed `killExecution` still cancels (logged).
- After cancel, the run is re-triggerable and re-snapshots cleanly.
- `billrun_operate` enforced (a `billrun_view` user → `FORBIDDEN`).

---

## Dependencies (packages to install)

**None.** Reuses the engine client, config, `insertAuditEvent`, timezone helpers.

---

## Verification checklist

- [ ] Typecheck/lint/format clean; `BILL_RUN_CANCELLED` in `AUDIT_EVENT_TYPES` + category map (+ coverage test); no new dependency.
- [ ] A run past `BILLRUN_STALL_THRESHOLD_MINUTES` without a heartbeat shows the `StallBanner` (derived); `STALLED` is never persisted.
- [ ] **Check status** reconciles against the engine (stub returns synthetic), bumps `last_progress_at`, consumes no invoice numbers.
- [ ] **Cancel run** → `CANCELLED`, accounts `PENDING`, execution ref cleared, `BILL_RUN_CANCELLED` audited, no invoice numbers consumed; a failed kill still cancels (logged).
- [ ] The cancelled run is re-triggerable (bm03 guard extended to `CANCELLED`) and re-snapshots fresh.
- [ ] `billrun_operate` enforced; docs updated same change set (`billmgmt-code-standards.md` §8 bm12 row + `billmgmt-progress-tracker.md`); the stall-threshold + cancel-re-trigger defaults recorded.
