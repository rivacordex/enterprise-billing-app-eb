# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- Phase 1 — Bill Run module build (bottom-up, one vertical unit per pass).

## Current Goal

- bm01 + bm02 + bm03 delivered: the Billing nav section, RBAC scaffold, the
  `billing.bill_run` header table, lazy materialization, the two-tab run list,
  and the Trigger/Run path (snapshot + scoping + mockable outbound engine).
  Next: bm04 (per-account stage ingest — the M2M signal path that drives
  `bill_run_account` past PENDING).

## Completed

- **bm01 — Billing section & RBAC scaffold** (`specs/bm01-billing-section-rbac-scaffold.md`).
  Auth/RBAC + app shell only; no domain tables.
  - Permission registry: `billrun_view` / `billrun_operate` / `billrun_approve`
    added to `PERMISSION_NAMES` (`types/rbac.ts`) + typed `PERMISSIONS.BILLRUN_*`
    constants (`auth/permission-constants.ts`). Rows land in migration
    `0024_billrun_permissions.sql` (`INSERT … ON CONFLICT DO NOTHING`).
  - Seeded role: `BILLING_VIEWER` added to `SEEDED_ROLE_NAMES` (protected by
    `isSeededRole`). Created + granted by the new `db/seeds/billing.ts`
    (`db:seed-billing`, wired into `db:setup`): BILLING_VIEWER → `billrun_view:READ`;
    ADMIN → `billrun_view:READ`, `billrun_operate:EDIT`, `billrun_approve:EDIT`.
    Idempotent (role pre-check + `onConflictDoNothing` on grants).
  - Route/page/states: `app/(app)/billing/bill-runs/{page,loading,error}.tsx` —
    `BillRunsPage` guards `billrun_view:READ` then renders `BillRunsEmptyState`
    (`components/billing/bill-runs-empty-state.tsx`, server component, scaffold
    empty state; no data fetch, no StubDataBanner, no CTA).
  - Nav: `Billing` section (`ReceiptText` icon, `billrun_view:READ`
    requiredPermission → fail-closed lock) inserted between Accounts and
    Administration in `components/admin-nav.tsx`.
  - Route × level matrix test: `tests/app/bill-runs-page.test.tsx`
    (granted → renders; no grant → /no-access; unauthenticated → /login).

- **bm02 — Bill Runs list + lazy materialization**
  (`specs/bm02-bill-runs-list-materialization.md`).
  - Schema: new `billing.bill_run` header table + `bill_run_seq` (`BRN` id),
    full plan §6.1 column set (materialize subset populated, rest nullable for
    later units), `(ref_bill_cycle_id, period_start)` UNIQUE + status/run_type/
    approver CHECKs. Migration `0025_skinny_calypso.sql` (drizzle-kit generated;
    reviewed). `db/schema/billing/bill-run.ts`, exported via the billing index.
  - Config: `STUB_DATA_MODE` env flag (`lib/config.ts` + `.env.example`) +
    frozen `stubDataMode` accessor.
  - Types: `RunStatus`/`RunType`/`RunListRow`/`RunListPage` (`types/billing.ts`);
    new `BILL_RUN_MATERIALIZED` audit event (Additive category).
  - Derivation: pure, total `currentDuePeriod(cycleDay, today)`
    (`services/billing/derive-periods.ts`) — single most-recent due period,
    current-month-anchored (no backfill), `null` when this month's run date
    hasn't arrived. `todayInZone` boundary helper added to `lib/timezone.ts`.
  - Repository: `insertMissingRuns` (ON CONFLICT DO NOTHING, RETURNING only
    inserted) + tab/cycle/status-filtered `listRuns`
    (`db/repositories/billing/bill-run.repository.ts`).
  - Services: `materializeDueRuns` (one txn, skips non-monthly with a logged
    note, one `BILL_RUN_MATERIALIZED` audit row per inserted, no-actor system
    write) and read `list-runs` (derived operability: oldest past-due
    `< APPROVED`; `*_FAILED` stays operable; upcoming disabled; `pastDue`).
  - Page + UI: `billing/bill-runs/page.tsx` guards → parses searchParams
    (`validation/billing/bill-runs-list.schema.ts`) → materializes → lists.
    Components: `BillRunList` (tabs via `<Link ?tab=>`, grouped Current +
    paginated Historical), `RunActionCard` (Run button inert — bm03),
    `RunStatusBadge` (11 states), `bill-runs-filters`, `bill-runs-pagination`,
    `StubDataBanner`/`StubBadge`, `ExportRunsButton`. Calendar dates via new
    `formatCalendarDate`.
  - CSV export: `actions/billing/export-runs.action.ts` (`'use server'`,
    re-checks `billrun_view:READ`, full filtered set, hand-rolled CSV, not
    audited); client `Blob` download.
  - Tests: `currentDuePeriod` unit (1/15/28, none-due-yet, month/year
    boundary), materialize service (monthly due / non-monthly skip / no-op
    zero-audit), list-runs operability + filters + pagination, CSV action,
    `RunStatusBadge` all 11, rewritten page route×level + stub-banner,
    integration idempotency (`tests/db/materialize-runs.integration.test.ts`,
    concurrent → exactly one row).

- **bm03 — Trigger a run (+ Scoping + outbound engine)**
  (`specs/bm03-trigger-scoping-engine.md`).
  - Schema: new partitioned `billing.bill_run_account` table (typing-only
    Drizzle declaration mirroring `db/schema/audit.ts`; physical DDL in
    `db/migrations/0027_bill_run_account.sql`) — composite PK
    `(bill_run_account_id, period_partition)`, UNIQUE
    `(ref_bill_run_id, ref_billing_account_id, period_partition)`, `AccountStatus`
    CHECK **including the new `EXCLUDED` member** (10 values, up from the
    plan's 9), `BRA` id default, default partition. `period_partition` is
    stamped as the 1st of the run's `period_start` month at snapshot time
    (`firstOfMonth`, `services/billing/derive-periods.ts`) — fixed per run,
    never insert time.
  - Partman bootstrap: `db/bootstrap/billing-partman-setup.{sql,ts}` +
    `db:setup-partman-billing` script, registering `billing.bill_run_account`
    with pg_partman (monthly, 4-premake, **7-year `retention_keep_table = true`
    detach-not-drop** per architecture §6.9 — deliberately different from
    `audit_log`'s drop-on-expiry policy). Reuses the existing
    `audit-log-partman-maintenance` daily cron (`run_maintenance_proc()` with
    no table arg sweeps every registered parent) — no second cron job.
  - Scoping: `services/billing/partial-period.ts` (`isPartialPeriod`, pure,
    **strict** boundary rule — a start on `period_start` or a cease on
    `period_end` is full-period) + `services/billing/scope-accounts.ts`
    (`scopeAccounts`, batches the active-account/window/transition repository
    reads and splits into `pending`/`excluded` snapshot rows). New repository
    finders (read-only, no ripple to the inventory module's insert-only
    structural test): `billingAccountRepository.findActiveByCycleId`,
    `productInventoryRepository.findWindowsByBillingAccountIds`,
    `inventoryStatusHistoryRepository.findTransitionsByInventoryIds`.
  - Engine client: `services/billing/engine-client.ts` — `EngineClient`
    interface, `realEngineClient` (Basic-Auth `fetch` to
    `${BILLRUN_ENGINE_URL}/executions/billing/bill_run`, typed `EngineError`
    on non-2xx/network/timeout/malformed-response), `stubEngineClient`
    (`stub-exec-{runId}`, no HTTP), `getEngineClient()` selecting by the new
    `isBillRunEngineConfigured` flag (`lib/config.ts` —
    `BILLRUN_ENGINE_URL`/`BILLRUN_ENGINE_AUTH`, both optional, absent ⇒ stub).
  - Trigger: `services/billing/trigger-run.ts` (`triggerRun`) — one
    `db.transaction`: `findByIdForUpdate` (row lock, double-trigger guard:
    reject unless `SCHEDULED` and `scheduled_run_date <= today`) →
    `scopeAccounts` → `billRunAccountRepository.insertSnapshot` → **the engine
    call runs inside the txn** — a thrown `EngineError` is caught, rethrown as
    an internal `EngineUnreachableSignal` so the whole transaction rolls back,
    then caught again outside `db.transaction` and mapped to
    `{ ok: false, code: "ENGINE_UNREACHABLE" }` (the DB write is discarded; the
    typed result is not). Success →
    `billRunRepository.markProcessing` (`PROCESSING`, `gl_event_at`,
    `triggered_by`, `last_progress_at`, the stored execution ref) →
    `insertAuditEvent(tx, BILL_RUN_TRIGGERED)`.
  - Action + UI: `actions/billing/trigger-run.action.ts` (`billrun_operate:EDIT`,
    `validation/billing/trigger-run.schema.ts` `BRN`-format check,
    `revalidatePath` on success only) → `components/billing/trigger-run-dialog.tsx`
    (`TriggerRunDialog`, the Deep-Petrol `--billrun-cta-bg` featured CTA +
    inline confirm/submitting/error states, `close-period-button.tsx`
    precedent) wired into `RunActionCard` (replacing bm02's inert disabled
    button). New CSS tokens in `app/globals.css`
    (`--billrun-cta-bg{,-hover,-active}`, `--billrun-cta-text`; base aliases
    the existing `--color-cyan-700`).
  - Audit: `BILL_RUN_TRIGGERED` added to `AUDIT_EVENT_TYPES`
    (`types/audit.ts`) and `AUDIT_EVENT_CATEGORY_MAP` as `"Change"`
    (`types/audit-log.ts`) — a state transition, not a new entity (unlike
    bm02's `BILL_RUN_MATERIALIZED`, `"Additive"`).
  - Tests: `partial-period.test.ts` (boundary + suspend/resume cases),
    `scope-accounts.test.ts`, `engine-client.test.ts` (stub + real, incl.
    non-2xx/network/malformed-body → `EngineError`), `trigger-run.service.test.ts`
    (happy path, double-trigger, upcoming-run, zero-eligible,
    engine-unreachable rollback, unrelated-error passthrough),
    `trigger-run.action.test.ts` (route × level matrix), `firstOfMonth` cases
    added to `derive-periods.test.ts`, `bill-run-account-schema.test.ts`
    (structural). Two DB-gated integration suites (`skipIf` no
    `DATABASE_URL`/`BOOTSTRAP_DATABASE_URL`, same as bm02's
    `materialize-runs.integration.test.ts` — **not run in this environment**,
    no local Postgres reachable): `trigger-run.integration.test.ts` (real
    snapshot + PROCESSING flip + double-trigger row-lock + zero-eligible; the
    engine-unreachable rollback path is proven at the unit level instead,
    where the failure can be injected deterministically) and
    `billing-partman-setup.integration.test.ts` (parent registered,
    `retention_keep_table = true`, ≥1 month partition materialized).

## In Progress

- None.

## Post-review hardening (bm02)

Fixes from a high-effort code review of the bm02 diff:

- **CSV/formula injection** — extracted the shared, formula-safe `lib/csv.ts`
  `csvField` (prefixes `= + - @ \t \r`, then RFC-4180 quotes); the bill-run
  export now uses it and `services/accounts/journal-csv.ts` was de-duplicated
  onto it (single hardening site).
- **Status filter is tab-scoped** — the filter UI shows Status only on
  Historical (terminal options); the read service drops an incompatible status
  (ignored on Current, non-terminal ignored on Historical), so operability is
  always resolved over a cycle's full non-terminal set and the "always-empty
  dead-end" is gone.
- **Pagination** — `listRuns` counts only when paginating and **clamps an
  out-of-range `?page=`** to the last real page (no false "no runs" empty
  state); repository split into `countRuns` + rows-only `listRuns`. Extracted
  the shared `components/common/list-pagination.tsx` (`noun` prop, `pageSize>0`
  guard); audit-log + bill-run paginations now delegate to it.
- **Page resilience** — lazy `materializeDueRuns` is wrapped so a failed write
  degrades to a logged error and still renders existing runs; the cycle list +
  run list run via `Promise.all`; the cycle filter / "no cycles" empty state
  now use `listActiveBillCycles` (matches what materialization iterates).
- **One business `today`** resolved once (`services/billing/business-today.ts`)
  and threaded into both materialize + list (no midnight-straddle skew).
- **Download** — `ExportRunsButton` defers `revokeObjectURL` so a larger
  download isn't cancelled.

Full DB-free vitest run green except the 4 pre-existing date-dependent action
suites; `typecheck`/`lint`/`format:check` clean.

Second review round (doc + hardening):

- **Filters survive tab switches** — the tab links preserve the cycle filter on
  both tabs and status on Historical (page always resets to 1); `BillRunsFilters`
  is re-keyed on filter/tab change so its draft selects re-seed from the URL
  (no stale mount-time values, no setState-in-effect).
- **Period-window DB checks** — `bill_run` now enforces `period_start <=
  period_end` (all runs) and, for on-cycle runs, `scheduled_run_date =
  period_end + 1` (guarded on `run_type` so modelled off-cycle runs stay open).
  Shipped as a new generated migration `0026_bill_run_period_checks.sql`
  (forward-only; 0025 left untouched).
- **`formatCalendarDate` day validation** — rejects impossible days (0,
  month-end overflow, Feb 29 in a common year), returning the raw input.
- **Docs aligned:** materialization is documented as the sole RSC-render entry
  point (removed from the Server Action lists in architecture §2 and overview);
  the overview retention contract now matches architecture Inv. #14 (approved-run
  rating records immutable for statutory life, not just "until COMPLETED").

## Next Up

- **bm04** — per-account stage ingest (the M2M signal path that advances
  `bill_run_account` past `PENDING`; the Uncharged tab reading `EXCLUDED`
  rows lands in bm07).

## Open Questions

- None for bm01.

## Architecture Decisions

- **Permission names are snake_case** (`billrun_view/operate/approve`), matching
  the delivered Accounts pattern; docs (architecture §4, code-standards §7/§8)
  already reflect this and the `/billing/bill-runs` route.
- **Three permissions, not one with levels** — segregation of duties (four-eyes):
  operate and approve must be grantable to different people.
- **Permission rows in a migration; grants in a seed** — established split
  (`0023`/`db:seed-ordering` precedent).
- **`billrun_*` are optional permissions** (`types/permissions.ts`
  `OptionalPermissionName`) — the resolver omits ungranted permissions and users
  predating the module hold none; this also prevents rippling `null` into every
  hardcoded `EffectivePermissionMap` fixture (same um06/pm25 move).

## Session Notes

- Context docs live under `context/billing-management/` (matches AGENTS.md).
  The folder was renamed from an earlier `billling-management` (triple-l) typo.
- Adding the three permission names required mechanical fixture updates in
  `tests/{auth/resolver, services/roles-read.service, components/{admin-nav,
  permission-matrix-editor,role-detail}}` (permission count 11 → 14) and
  registering `/billing/bill-runs` in `tests/app/route-manifest.test.ts` — the
  same ripple pm25 handled when it added the two ordering permissions.
- Pre-existing, unrelated: the 4 date-dependent action suites
  (`create-order`, `resume/suspend/terminate-subscription`) fail on the clean
  baseline too (hardcoded dates now >3 days in the past vs. 2026-08-19).
- **bm02 ripples** from the new `BILL_RUN_MATERIALIZED` audit event +
  `STUB_DATA_MODE` config field: mechanical updates to
  `tests/components/audit-log-filters.test.tsx` (option count 62 → 63) and
  `tests/lib/config.test.ts` (full-config `toEqual` gains `STUB_DATA_MODE`),
  same class of ripple bm01's permission-count change caused. `typecheck` /
  `lint` / `format:check` / `validate:env` all clean; full DB-free vitest run
  green except the 4 pre-existing date suites above.
- **bm02 migration `0025` was generated (`db:generate`) and reviewed but NOT
  applied** — no local Postgres is reachable in this environment, so
  `db:migrate` (and the DB-backed `materialize-runs.integration.test.ts`) must
  be run wherever the database lives. The generated SQL is the clean
  sequence + table + unique + 3 CHECKs + `BRN` default + 3 FKs.
- **Window-derivation decision (recorded so it isn't re-litigated):**
  `currentDuePeriod` is *current-month-anchored* — it considers ONLY this
  month's `cycle_day` and returns `null` when `today` is before it. This is
  what implements "no multi-month backfill": a month whose page was never
  opened between its run date and the next is never retro-created; an earlier
  `SCHEDULED` run already materialized simply stays operable oldest-first via
  the list read. The plan docs `_newmodule-billing-billrun-plan.md` /
  `bm00-build-plan.md` referenced by the spec are not in the repo, so the
  bm02 spec (Design §Structural) was the authoritative source.
- **bm03 migration `0027_bill_run_account.sql` is hand-authored raw SQL (not
  drizzle-kit generated)** — Drizzle can't express `PARTITION BY`, so it
  follows the `0001_audit.sql` precedent exactly (composite PK, default
  partition, journal entry added by hand). Like bm02's `0025`, it was
  reviewed but **NOT applied** — no local Postgres is reachable in this
  environment; `db:migrate` then `db:setup-partman-billing` must be run
  wherever the database lives, in that order (the bootstrap script assumes
  the migration's parent table already exists).
- **`TriggerRunDialog` confirm copy deviates from the spec's literal template**
  (`"...snapshots {N} eligible accounts..."`) — scoping only runs server-side
  at click time, so no pre-click count exists without adding a preview
  endpoint outside bm03's scope (Discipline: no surface beyond what's listed
  in Implementation §1–9). The dialog asks to run the period without a count;
  the actual `banCount`/`excludedCount` appear in the post-trigger success
  message instead. Revisit only if a future unit adds a cheap pre-trigger
  eligible-count read.
- **bm03 ripples** from the new `BILL_RUN_TRIGGERED` audit event +
  `BILLRUN_ENGINE_URL`/`BILLRUN_ENGINE_AUTH` config fields: mechanical updates
  to `tests/components/audit-log-filters.test.tsx` (option count 63 → 64) and
  `tests/lib/config.test.ts` (`ENV_KEYS` gains the two engine vars; new
  `billRunEngineConfig`/`isBillRunEngineConfigured` test coverage) — same
  class of ripple bm01/bm02 hit. `AUDIT_EVENT_CATEGORY_MAP`'s own coverage
  test (`tests/types/audit-log.test.ts`) iterates `AUDIT_EVENT_TYPES`
  dynamically and needed **no** change, unlike the filter-count ripple.
- **No inventory-module structural-test ripple** — the three new repository
  finders added for scoping (`findActiveByCycleId`,
  `findWindowsByBillingAccountIds`, `findTransitionsByInventoryIds`) are all
  read-only (`find*`), so `tests/db/ordering-repository-exports.test.ts`'s
  insert-only assertion on `inventoryStatusHistoryRepository` /
  insert-once assertion on `productInventoryRepository` needed no update.
- **No 28-file `DROP SCHEMA CASCADE` ripple** (unlike the `new-pgschema-
  integration-test-ripple` memory) — `bill_run_account` lives in the
  already-provisioned `billing` schema, not a new `pgSchema`, so no existing
  integration test's `beforeAll`/`afterAll` needed touching.
