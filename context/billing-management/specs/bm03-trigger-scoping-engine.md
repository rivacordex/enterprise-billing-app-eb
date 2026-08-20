# bm03 — Trigger a run (+ Scoping + outbound engine) — Spec

**Unit:** bm03 (`bm00-build-plan.md`). **Boundary:** `bill-runs` operate path + outbound workflow integration. **Depends on:** bm02 (`bill_run`, list); `billing.billing_account` (`ref_bill_cycle_id` FK) + `productInventory`/`inventoryStatusHistory` (`db/schema/inventory.ts`); a workflow engine — **treated as not-yet-deployed → mockable client** (per project decision).
**Grounded in** `F:/Projects/enterprise-billing-app/`: `db/schema/billing/accounts.ts` (`billing_account.ref_bill_cycle_id`), `db/schema/inventory.ts`, `db/bootstrap/audit-partman-setup.{ts,sql}` + `db/migrations/0001_audit.sql` (partman pattern), `lib/config.ts`, `actions/accounts/close-period.action.ts` + `components/accounts/close-period-button.tsx` + `services/accounts/close-billing-account.ts` (action→dialog→service(txn)→audit), `types/audit.ts` + `types/audit-log.ts` + `tests/types/audit-log.test.ts`, `db/client.ts` (`Database`/`tx`).

> **Resolved decisions:** (1) **eligibility** = the cycle's `state = 'active'` accounts only — **no `rating_type` or `payment_status` filter** in v1 (prepaid and in-dispute accounts are scoped in the same as any other active account); (2) partial-period exclusions are recorded **in `bill_run_account`** as rows with a new `EXCLUDED` status (no new table — there is no `rating.udr_exception` in v1); the Uncharged tab (bm07) reads them; (3) the engine call runs **inside** the trigger transaction so a failure rolls the whole trigger back cleanly (run stays `SCHEDULED`); (4) partial-period is **strict** — a start on `period_start` or a cease on `period_end` is full-period.

---

## Goal

Clicking **Run** on an operable run snapshots the cycle's eligible active billing accounts into a new monthly-partitioned `billing.bill_run_account` table (marking any account with a partial-period subscription `EXCLUDED`), resolves `gl_event_at = scheduled_run_date`, flips the run `SCHEDULED → PROCESSING`, and starts a workflow execution through a config-gated **mockable engine client** — rejecting a second trigger while the run is `PROCESSING`.

---

## Design

### Structural
- **New table `billing.bill_run_account`** — **RANGE-partitioned on `period_partition` (monthly)** via pg_partman, following the `audit_log` pattern exactly (Drizzle schema for typing only; physical `PARTITION BY` in a raw-SQL migration; composite PK includes the partition key). Columns (plan §6.2): `bill_run_account_id` (`BRA…`), `ref_bill_run_id` FK, `ref_billing_account_id` FK, `period_partition` date, `status` (`AccountStatus` CHECK), `attempt_count` int default 1, `error_code`/`error_detail` nullable, `last_processed_at`. **Composite PK `(bill_run_account_id, period_partition)`**, **UNIQUE `(ref_bill_run_id, ref_billing_account_id, period_partition)`**. `period_partition` = the 1st of the run's period month (fixed per run — architecture Inv. #11), stamped from the parent `bill_run.period_start`, **not** insert time.
- **This unit establishes the billing pg_partman bootstrap** (`db/bootstrap/billing-partman-setup.{ts,sql}` + a `db:setup-partman-billing` script) that bm04/bm05/bm06's partitioned tables extend. Monthly premake + **84-partition (7-year) retention** via `partman.part_config`; daily `run_maintenance_proc` cron (audit_log precedent).
- **`AccountStatus` union** = `PENDING | PROCESSING | PROCESSED | INVOICED | DISTRIBUTING | COMPLETED | PROCESSING_FAILED | DISTRIBUTION_FAILED | SKIPPED` **+ `EXCLUDED`** (new — scoping-time partial-period exclusion; see flagged decision).
- **Scoping (app-side, at trigger, before the engine call):** select `billing_account` where `ref_bill_cycle_id = <run's cycle>` and `state = 'active'` — **all** active accounts of the cycle, **no `rating_type` or `payment_status` filter** in v1; snapshot them into `bill_run_account` (frozen population). For each account, run the **partial-period predicate** over the run window `[period_start, period_end]`; an account with **any** partial-period subscription is written `status = 'EXCLUDED'`, `error_code = 'PARTIAL_PERIOD'` and is **not** passed to the engine; the rest are `PENDING`. `ban_ids` sent to the engine = the `PENDING` accounts only.
- **Partial-period predicate** (`services/billing/partial-period.ts`, pure over calendar dates): true if, for an account, any `productInventory` row has `start_date` **strictly after** `period_start` (started mid-period), or `end_date` **strictly before** `period_end` while `>= period_start` (ceased mid-period), or an `inventoryStatusHistory` transition to `SUSPENDED`/`RESUMED` with `effective_date` **strictly inside** `(period_start, period_end)`. **A start on `period_start` or a cease on `period_end` is full-period** (not excluded). Reads `productInventory` (`billing_account_id` FK) + `inventoryStatusHistory`.
- **Trigger transaction** (one `db.transaction`): `SELECT … FOR UPDATE` the `bill_run` row → **double-trigger guard** (reject unless `status = 'SCHEDULED'` and `scheduled_run_date <= today`) → snapshot accounts (scoping) → call `engineClient.startExecution(payload)` → stamp `status = 'PROCESSING'`, `gl_event_at = scheduled_run_date`, `triggered_by = actor`, `last_progress_at = now()` and store the returned `workflow_execution_id` / `workflow_definition_id` / `workflow_definition_revision` → `insertAuditEvent(tx, BILL_RUN_TRIGGERED)`. **The engine call is inside the txn** (flagged decision): a failure throws → the whole trigger rolls back, the run stays `SCHEDULED`, no orphan snapshot. The row lock makes a concurrent second click block then bounce on the `PROCESSING` check.
- **Trigger payload:** `{ bill_run_id, period_start, period_end, ban_ids, attempt, gl_event_at }` (`attempt` = 1 at first trigger).
- **Mockable engine client** `services/billing/engine-client.ts` — an interface `{ startExecution(payload): Promise<ExecutionRef> }` with two impls selected by config: a **real** `fetch` to `BILLRUN_ENGINE_URL` (Basic-Auth from Key Vault/env); a **stub** (when `!isBillRunEngineConfigured`) returning a synthetic `executionId` (`stub-exec-{runId}`) with no HTTP — the pipeline is then driven by test callers hitting bm04's ingest. Tests inject a mock. This keeps bm03 fully testable with no live Kestra.

### Visual (`billmgmt-ui-context.md`)
- The **Run** button on `RunActionCard` uses the module **Deep-Petrol featured CTA** (`--billrun-cta-bg`, §7) — the one accent action per screen. It opens `TriggerRunDialog`: "Run {cycleName} for {period}? This snapshots the cycle's eligible accounts and starts processing." (no pre-click `{N}` count — scoping happens server-side at click time) with a confirm; disabled/inert for upcoming runs.
- On success the run row flips to `PROCESSING` (the per-stage detail view is bm04); `router.refresh()`.
- The engine-unreachable path surfaces a non-leaking inline error (`role="alert"`, rendered in the confirmation panel — not a toast); the run remains `SCHEDULED` (rolled back), so Run can be retried.

---

## Implementation

### 1. Schema (typing) — `db/schema/billing/bill-run-account.ts`
Drizzle table for **query typing only** (comment it, mirroring `db/schema/audit.ts`): the columns above, `primaryKey({ columns: [t.billRunAccountId, t.periodPartition] })`, the unique index, the `AccountStatus` CHECK, `BRA` id default (`sql\`'BRA' || lpad(nextval('billing.bill_run_account_seq')::text, 8, '0')\``) + `billRunAccountSeq`. Export from `db/schema/index.ts`.

### 2. Migration (physical, partitioned) — `db/migrations/NNNN_bill_run_account.sql`
Custom SQL migration (Drizzle can't express `PARTITION BY`). `CREATE SEQUENCE billing.bill_run_account_seq`; `CREATE TABLE billing.bill_run_account (…) PARTITION BY RANGE (period_partition)`; the composite PK, unique, CHECK, and FKs (`ref_bill_run_id → bill_run`, `ref_billing_account_id → billing_account`); a `billing.bill_run_account_default` default partition; indexes on `(ref_bill_run_id)` and `(period_partition)`. (FKs to a partitioned table's parent are allowed; the referencing side is fine.)

### 3. Partman bootstrap — `db/bootstrap/billing-partman-setup.{sql,ts}` + script
Mirror `audit-partman-setup`: `partman.create_parent(p_parent_table := 'billing.bill_run_account', p_control := 'period_partition', p_interval := '1 month', p_type := 'range', p_premake := 4, p_default_table := false)`; `UPDATE partman.part_config SET retention = '7 years', retention_keep_table = true …` (**detach-and-archive**, not drop — architecture §6.9, so `retention_keep_table = true`); reuse the daily `partman.run_maintenance_proc` cron (do not add a second). Add `db:setup-partman-billing` to `package.json` and to the `db:setup` chain after `db:migrate`.

### 4. Config — `lib/config.ts`
Add `BILLRUN_ENGINE_URL: z.string().url().optional()` and `BILLRUN_ENGINE_AUTH: z.string().optional()` (Basic-Auth credential; Key Vault in prod, `.env` locally). Export `billRunEngineConfig` + `isBillRunEngineConfigured` (both URL and auth present). Add both to `.env.example` (commented; absent ⇒ stub mode).

### 5. Engine client — `services/billing/engine-client.ts`
`export interface EngineClient { startExecution(p: TriggerPayload): Promise<ExecutionRef> }`. `realEngineClient` — `fetch(\`${url}/executions/{namespace}/{definition}\`, { method: 'POST', headers: { Authorization: \`Basic ${b64}\` }, body: JSON })`, maps the response to `{ executionId, definitionId, definitionRevision }`; throws a typed `EngineError` on non-2xx/timeout. `stubEngineClient` — returns `{ executionId: \`stub-exec-${p.bill_run_id}\`, definitionId: 'billing.bill_run', definitionRevision: 0 }`, logs via `lib/logger`. `getEngineClient()` picks by `isBillRunEngineConfigured`. Framework-agnostic (no `next/*`).

### 6. Scoping service — `services/billing/scope-accounts.ts`
`scopeAccounts(tx, run): { pending: BillRunAccountInsert[]; excluded: BillRunAccountInsert[] }` — query active accounts for the cycle, evaluate `isPartialPeriod(account, window)` per account (batched read of `productInventory` + `inventoryStatusHistory`), build snapshot rows with `period_partition = firstOfMonth(run.periodStart)`. Pure predicate in `services/billing/partial-period.ts`, unit-tested.

### 7. Trigger service + action + components
- `services/billing/trigger-run.ts` — the transaction described in **Design** (guard, scope, PROCESSING, `gl_event_at`, engine call, store execution ref, `insertAuditEvent(tx, { eventType: 'BILL_RUN_TRIGGERED', targetEntity: 'BILL_RUN', targetId: runId, afterData: { banCount, excludedCount, executionId } })`), returning a typed `Result` (`ok` | `NOT_OPERABLE` | `NO_ELIGIBLE_ACCOUNTS` | `ENGINE_UNREACHABLE`).
- `actions/billing/trigger-run.action.ts` — `'use server'`: `requirePermission(PERMISSIONS.BILLRUN_OPERATE, LEVELS.EDIT)` (catch redirect → `FORBIDDEN`) → `triggerRunSchema.safeParse` (`{ billRunId }`) → `triggerRun` → on `ok` `revalidatePath('/billing/bill-runs')`.
- `components/billing/run-action-card.tsx` — the Deep-Petrol **Run** button (enabled only for the operable run) → `trigger-run-dialog.tsx` (`TriggerRunDialog`, confirm + submitting/error states, `router.refresh()` on success), following `close-period-button.tsx`.

### 8. Audit event — `types/audit.ts`, `types/audit-log.ts`, test
Add `BILL_RUN_TRIGGERED` to `AUDIT_EVENT_TYPES` **and** `AUDIT_EVENT_CATEGORY_MAP` (`"Additive"`); the existing `tests/types/audit-log.test.ts` coverage test enforces the map entry (`tsc` won't catch the map — update it explicitly).

### 9. Tests — `tests/…`
Route × level matrix on the trigger action (`billrun_operate:EDIT`; a `billrun_view`-only principal → `FORBIDDEN`). Happy trigger: snapshots N accounts, run → `PROCESSING`, `gl_event_at = scheduled_run_date`, `workflow_execution_id` stored, `BILL_RUN_TRIGGERED` audited. **Double-trigger** rejected while `PROCESSING`. Zero eligible accounts → `NO_ELIGIBLE_ACCOUNTS` (no PROCESSING). **Engine unreachable** (mock throws) → txn rolls back, run stays `SCHEDULED`, no snapshot rows. `isPartialPeriod` unit tests (start/cease/suspend mid-period vs full-period; boundary dates). `period_partition` = 1st of `period_start` even for a cross-month rerun. Partman: the parent is registered and a month partition exists.

---

## Dependencies (packages to install)

**None.** `fetch` is native (Node ≥ 22); `postgres`/`drizzle-orm`/`zod`/`lucide-react`/`cva` are present. pg_partman/pg_cron are DB extensions already provisioned (audit_log uses them) — no npm change.

---

## Verification checklist

Schema & partitioning
- [ ] `db/migrations/NNNN_bill_run_account.sql` creates the RANGE-partitioned table on `period_partition` with composite PK `(bill_run_account_id, period_partition)`, the unique `(ref_bill_run_id, ref_billing_account_id, period_partition)`, CHECK, FKs, and a default partition; `db:migrate` applies clean.
- [ ] `db:setup-partman-billing` registers `billing.bill_run_account` with pg_partman (monthly, premake, 7-year **detach** retention) and a month partition is present; typecheck/lint/format clean; `AccountStatus` (incl. `EXCLUDED`) in `types/billing.ts`; table exported from `db/schema/index.ts`.

Trigger (the visible result)
- [ ] Run on an operable run snapshots the cycle's active accounts into `bill_run_account` (`period_partition` = 1st of `period_start`), flips the run to `PROCESSING`, stamps `gl_event_at`/`triggered_by`/`last_progress_at`, stores the (stub or real) `workflow_execution_id`, and writes `BILL_RUN_TRIGGERED`.
- [ ] Accounts with a partial-period subscription are `EXCLUDED` (`error_code = 'PARTIAL_PERIOD'`) and omitted from `ban_ids`; full-period accounts are `PENDING`.
- [ ] A second Run while `PROCESSING` is rejected (row-lock + status guard); `billrun_operate` is required (a `billrun_view` user is `FORBIDDEN`, server-checked).
- [ ] Engine-unreachable (mock throws) rolls the trigger back — run `SCHEDULED`, zero snapshot rows — and surfaces a non-leaking error; retry works.
- [ ] With no engine configured, the stub client returns a synthetic execution id and the trigger still completes (pipeline then driven by bm04 ingest).

Discipline
- [ ] No `bill_run_account_stage`, `customer_bill`, or ingest endpoint is built (bm04+); the engine client has no `next/*` import; the Run button is the only Deep-Petrol CTA on the screen.
- [ ] Docs updated same change set: `billmgmt-code-standards.md` §8 (bm03 row) + `billmgmt-progress-tracker.md`; the `EXCLUDED` status + in-txn engine-call decisions recorded.
