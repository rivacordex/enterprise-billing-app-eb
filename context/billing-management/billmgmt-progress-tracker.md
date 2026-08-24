# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- Phase 1 — Bill Run module build (bottom-up, one vertical unit per pass).

## Current Goal

- **bm01–bm13 delivered — the build plan's final unit is done.** bm13 (End-to-
  end journey & ship gate) aggregated/confirmed the route × level matrix
  (three pages + two M2M handlers, incl. operate≠approve + four-eyes), the
  code-standards §9 module guardrail tests (with the recorded v1 rating-
  adaptation), added the one E2E happy-path journey integration test, added
  a DB-level finalization-latch trigger the guardrail audit found missing,
  confirmed SAST + OWASP ZAP DAST CI gates, and confirmed the permission map/
  route manifest list exactly the three pages + two handlers. See the bm13
  entry below for detail. No further units remain in `bm00-build-plan.md`.
- bm01–bm12 delivered: the Billing nav section, RBAC scaffold, the
  `billing.bill_run` header table, lazy materialization, the two-tab run list,
  the Trigger/Run path, the M2M stage-ingest path driving `bill_run_account`
  past `PENDING` to `PROCESSED`/`PROCESSING_FAILED` with the Workflow tab's live
  stage timeline, the trial `customer_bill` draft-bill generation
  (Collection/Aggregation) with the Customers & Bills tab, Taxation
  (`customer_bill_tax_item`, SQL-computed GST `tax_total`/`total_amount`),
  Verification's per-stage effect (`DONE` + a `SOFT` backstop finding) with the
  remaining run-detail tabs Uncharged/Errors/Audit (no new table), Rerun
  (full & partial, attempt-keyed re-derivation), and the cross-module
  Accounts-side `INV` document type + posting enablement (sequence, widened
  CHECKs, `STANDARD_INVOICE` auto-post, INV leg template, the period-close
  `BILL_RUN_IN_PROGRESS` guard — additive only, no INV posting UI yet), and
  Approve (the four-eyes money gate: pre-approval checks, `approveRun`
  stamping the immutable total and marking failed/excluded accounts
  `SKIPPED`, the `/approve` page), and bm11 Posting (per-account INV posting
  through the Accounts document engine, run `status` transitioning `APPROVED →
  POSTING → COMPLETED` — `INVOICED` is the per-account milestone (not a run
  status the run passes through) and `invoiced_at` is a run timestamp stamped
  at completion — resumable, checksum-stamped, the `PostingProgressView`), and
  bm12 Stall detection & recovery (derived `STALLED`, `StallBanner`'s Check
  status / Cancel run, the extended trigger guard making a cancelled run
  re-triggerable). bm13 (End-to-end journey & ship gate) closes the build
  plan: a tests/CI-boundary unit — no new page, permission, or feature; stub-
  data mode + badging were already delivered in bm02, ahead of `ai-workflow-
  rules.md` §2's original unit-12 reference placement — that aggregates/
  confirms the route × level matrix and the code-standards §9 guardrails,
  adds the one E2E happy-path integration test, and closes one real gap the
  guardrail audit found (see the bm13 entry below).

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

- **bm04 — M2M stage ingest + stage-timeline observability**
  (`specs/bm04-stage-ingest-observability.md`).
  - Schema: new partitioned `billing.bill_run_account_stage` table (typing-
    only Drizzle declaration, `db/schema/billing/bill-run-account-stage.ts`;
    physical DDL `db/migrations/0028_bill_run_account_stage.sql`, following
    the bm03 `bill_run_account`/`audit_log` hand-authored-partition pattern —
    not drizzle-kit generated) — composite PK `(bill_run_account_stage_id,
    period_partition)`, the idempotency-latch UNIQUE `(ref_bill_run_id,
    ref_billing_account_id, stage, attempt, period_partition)`, `Stage`/
    `StageStatus`/`ErrorClass` CHECKs, FKs to `bill_run`/`billing_account`,
    default partition. `db/bootstrap/billing-partman-setup.sql` extended with
    a second `partman.create_parent` registration for the new table (same
    monthly/7-year-detach shape as `bill_run_account`; one shared
    `run_maintenance_proc()` call covers both parents, no second cron job).
  - Types: `Stage` (9 members)/`StageStatus`/`ErrorClass` unions,
    `RunDetail`/`StageTimelineRow`/`StageTimelineCell`/`StageTimelineSummary`
    read models (`types/billing.ts`).
  - Config + auth: `BILLRUN_APP_TOKEN` (optional, min 32 chars,
    `lib/config.ts` + `.env.example`) — absent ⇒ every M2M call 401s
    (fail-closed). `lib/service-token.ts` (`serviceTokenMatches` mirrors
    `csrfTokensMatch`'s length-guard + `timingSafeEqual` idiom;
    `requireServiceToken` extracts `Authorization: Bearer`, throws
    `UNAUTHENTICATED` on any miss, never logs the token).
  - Validation: `validation/billing/{run-id,stage-signal,status-push,
    run-detail}.schema.ts` — `stageSignalBodySchema` accepts no charge
    fields; `statusPushBodySchema` is `{ status: "PROCESSING_FAILED",
    error_detail? }` (see Session Notes — the spec left this body's exact
    shape unstated beyond "an execution-failure marks the run
    PROCESSING_FAILED").
  - Route Handlers: `app/api/billrun/[runId]/stage/[stage]/complete/route.ts`
    and `.../status/route.ts` — `requireServiceToken` → Zod-parse params +
    body → delegate → `toHttpResponse`. No `getSession`, no business logic.
  - Services: `services/billing/handle-stage-signal.ts` (the transaction:
    `findByIdForUpdate` row-lock + `PROCESSING` guard → insert the stage row
    first, catching a unique-violation as a `replayed: true` 200 no-op → the
    Validation stage's outcome is **computed by the app**
    (`validate-account.ts`, a readiness gate over
    currency/bill-cycle/payment-terms resolvability — overrides whatever the
    caller's body said for that stage only); every other stage is pass-
    through record-and-advance → `advanceAccountStatus` (pure, exported for
    testing: `PENDING→PROCESSING` on first signal, `HARD`→
    `PROCESSING_FAILED`, `INFRA`→ no terminal change, the terminal stage
    `verification` `DONE`/`SKIPPED` → `PROCESSED`) → recompute
    `bill_run.status` via the pure `compute-run-status.ts` (`PROCESSED` once
    every account is `PROCESSED`/`PROCESSING_FAILED`/`EXCLUDED` — `EXCLUDED`
    counts as terminal since bm03 never signals it) under the row lock
    already held by `findByIdForUpdate` (no second lock). The optional
    `ban_count`/`rated_count`/`failed_count` cache is refreshed from the same
    derived counts every recompute (stored == derived by construction).
    `handle-status-push.ts` is the narrower execution-failure push,
    `PROCESSING` → `PROCESSING_FAILED`. No `AUDIT_LOG` write in either path —
    the appended stage row is the audit surface.
  - Repositories: `bill-run-account-stage.repository.ts`
    (`insertStageRow`/`listLatestForRun` via `selectDistinctOn` picking the
    highest attempt per `(account, stage)`); `bill-run-account.repository.ts`
    extended with `findStatus`/`updateStatus`/`listStatusesForRun`;
    `bill-run.repository.ts` extended with `findDetailById`/
    `recomputeStatus`/`markProcessingFailed`.
  - Detail page + Workflow tab: `app/(app)/billing/bill-runs/[runId]/`
    (`page.tsx` guards `billrun_view:READ`, parses `runId`, `notFound()` on
    invalid/unknown, `generateMetadata`, `force-dynamic`; `loading.tsx`/
    `error.tsx`). `components/billing/`: `run-detail-tabs.tsx`
    (`?tab=` switcher; Workflow renders `StageTimeline`, the other four are
    inert placeholders for bm05-07), `stage-timeline.tsx`, and three new
    badges — `stage-status-badge.tsx`, `error-class-badge.tsx`, and
    `account-status-badge.tsx` (code-standards §4.1 — ships with "the first
    unit that renders a per-account row", which is this one). Read services:
    `services/billing/read/{get-run-detail,get-stage-timeline}.ts` — both
    derive live, no cache read.
  - Tests: `lib/service-token.test.ts`, `compute-run-status.test.ts`,
    `validate-account.test.ts`, `handle-stage-signal.test.ts` (guards,
    replay/idempotency, HARD/INFRA/terminal-stage advancement, the
    Validation stage's app-computed override, `advanceAccountStatus` pure
    unit cases), `handle-status-push.test.ts`, `get-stage-timeline.test.ts`,
    the two M2M route-handler auth/status-code matrices
    (`tests/app/api/billrun-{stage-complete,status}.test.ts`),
    `bill-run-account-stage-schema.test.ts` (structural), the three new
    badge coverage tests, and `bill-run-detail-page.test.tsx` (route × level
    matrix: guard-first, `notFound()` on invalid/unknown run, redirect
    propagation, force-dynamic, stub-banner). DB-gated integration coverage
    (concurrent-signal atomicity under `FOR UPDATE`, the real unique-
    violation replay path) is **not added in this environment** — no local
    Postgres reachable, same constraint noted for bm02/bm03's integration
    suites.
  - `typecheck`/`lint`/`format:check` clean; full DB-free vitest run passes
    except a known pre-existing failing set (238/243 files, 2470/2484 tests;
    5 files/14 tests failing) — those are all in
    `tests/actions/{create-order,resume,suspend,terminate}-
    subscription*` and are the **same pre-existing, unrelated hardcoded-date
    drift** noted for bm01-bm03 (now 5 files instead of 4, since today,
    2026-08-20, pushed one more borderline case past the "3 days in the
    past" threshold); confirmed via `git status`/`git diff` that bm04
    touched none of those files.

- **bm05 — Draft bill generation (Claim + Aggregation)**
  (`specs/bm05-draft-bill-generation.md`).
  - Schema: new partitioned `billing.customer_bill` table (typing-only
    Drizzle declaration, `db/schema/billing/customer-bill.ts`; physical DDL
    `db/migrations/0029_customer_bill.sql`, following the bm03/bm04 hand-
    authored-partition pattern — not drizzle-kit generated) — composite PK
    `(customer_bill_id, period_partition)`, UNIQUE `(ref_bill_run_id,
    ref_billing_account_id, period_partition)`, `BillCategory`/`BillState`
    CHECKs, `CBL` id default, FKs to `bill_run`/`billing_account` only (
    `ref_bill_format_id`/`ref_bill_template_version_id` are reserved,
    nullable, **no FK** — the catalog/rendering phase is deferred), the
    nullable `ref_inv_document_id`/`posted_attempt`/`charge_checksum`
    finalization-latch columns (none populated in v1), default partition.
    `db/bootstrap/billing-partman-setup.sql` extended with a third
    `partman.create_parent` registration (same monthly/7-year-detach shape
    as `bill_run_account`/`bill_run_account_stage`; the existing shared
    `run_maintenance_proc()` call still covers all three parents, no second
    cron job). `BillCategory`/`BillState` unions + the `CustomerBillRow` read
    model added to `types/billing.ts`.
  - Collection/Claim (stage 3): `services/billing/collect-claim.ts`
    (`collectClaim`) — a pure, synchronous v1 no-op that always returns
    `DONE`, wired into `handle-stage-signal.ts` as a third app-computed
    override alongside bm04's Validation (the caller's signalled
    status/error fields are discarded for this stage, same as Validation).
    No `rating.*` object exists yet, so there is no claim repository, no
    rating grant, and no cross-schema write — a `// deferred: rating claim +
    grant land with the rating engine` marker documents where the real claim
    goes.
  - Aggregation (stage 4): `services/billing/aggregate-bill.ts`
    (`aggregateBill(tx, run, banId)`) — resolves the payment-term days via
    the existing `coalesce(account.paymentDueDaysOverride, cycle.paymentDueDays)`
    resolution (`resolveTerm`, reused from `validate-account.ts`'s
    precedent), computes `payment_due_date` via the new pure `addDays`
    helper (`services/billing/derive-periods.ts`, UTC `Date.UTC` math,
    `currentDuePeriod`'s idiom) applied to `run.scheduledRunDate`, and writes
    the trial row through a rerun-safe conditional `DELETE ... WHERE
    ref_inv_document_id IS NULL` + INSERT
    (`db/repositories/billing/customer-bill.repository.ts`). `subtotal` is a
    **deterministic synthetic stub** (`deriveStubSubtotal`, exported for
    testing) — a pure, stable function of `billing_account_id` alone (a base
    + a per-account increment derived from the BAN's numeric suffix mod
    1000, **no randomness**), computed in integer sen via the platform
    decimal helper (`services/accounts/money.ts`'s `senToString`), never JS
    float. `tax_total` is hardcoded `"0.00"` and `total_amount` equals
    `subtotal` in v1 — Taxation (bm06) is out of scope here. Wired into
    `handle-stage-signal.ts` as a **side effect** (not an outcome override,
    unlike Validation/Collection): a `DONE` `aggregation` signal triggers
    `aggregateBill` inside the same transaction, after the idempotency-latch
    stage-row insert succeeds — a replayed (duplicate) signal never reaches
    it, and a `FAILED` aggregation signal never triggers it.
  - Customers & Bills tab: fills the bm04 placeholder.
    `services/billing/read/list-account-bills.ts` (`listAccountBills`) joins
    `customer_bill` → `billing_account` for the account name/currency (
    neither lives on `customer_bill`) — `EXCLUDED` accounts never appear
    structurally (they never reach Aggregation; bm04's
    `advanceAccountStatus` keeps them terminal, so no row is ever written
    for them). `components/billing/`: `bill-category-badge.tsx`
    (`BillCategoryBadge` — `trial` renders outline-only per ui-context §5,
    the one badge family in this module that does) and
    `customer-bill-table.tsx` (`CustomerBillTable` — a **server component**;
    the per-row charge-lines expander is a native `<details>` disclosure, so
    no `'use client'` leaf was needed, unlike every other interactive leaf in
    this module). `app/(app)/billing/bill-runs/[runId]/page.tsx` now also
    resolves `getAppLocale()` and reads `listAccountBills` only for the
    `customers` tab (same fetch-only-for-active-tab idiom as the Workflow
    timeline).
  - Tests: `customer-bill-schema.test.ts` (structural), `collect-claim.test.ts`,
    `aggregate-bill.test.ts` (rerun-safe delete-before-insert ordering, term
    resolution incl. override, `deriveStubSubtotal` determinism/stability),
    `list-account-bills.test.ts`, `bill-category-badge.test.tsx` (all 3
    values + the trial outline-only assertion), `handle-stage-signal.test.ts`
    extended with the Collection override and the Aggregation side-effect
    (DONE triggers it, FAILED/replay/other-stages don't), and
    `bill-run-detail-page.test.tsx` extended to assert `listAccountBills` is
    only called for the `customers` tab. `typecheck`/`lint`/`format` clean;
    full DB-free vitest run passes except a known pre-existing failing set
    (244/248 files, 2512/2526 tests; 4 files/14 tests failing) — those are the
    same pre-existing, unrelated hardcoded-date drift noted for bm01-bm04 (`tests/actions/{create-order,
    resume,suspend,terminate}-subscription*`); confirmed via `git status`/
    `git diff` that bm05 touched none of those files.

- **bm06 — Taxation** (`specs/bm06-taxation.md`).
  - Schema: new partitioned `billing.customer_bill_tax_item` table (typing-only
    Drizzle declaration, `db/schema/billing/customer-bill-tax-item.ts`; physical
    DDL `db/migrations/0030_customer_bill_tax_item.sql`, hand-authored-partition
    pattern — not drizzle-kit generated) — composite PK
    `(customer_bill_tax_item_id, period_partition)`, the **first composite FK in
    the module** to `customer_bill` on `(ref_customer_bill_id, period_partition)`
    (matching the partitioned parent's full PK), `CBT` id default +
    `customer_bill_tax_item_seq`, `tax_rate numeric(5,2)`/`tax_amount
    numeric(18,2)`, **no JSONB** (financially significant, code-standards §6.12),
    default partition. `db/bootstrap/billing-partman-setup.sql` extended with a
    fourth `create_parent` registration (same monthly/7-year-detach shape; the
    existing shared `run_maintenance_proc()` covers all four parents, no second
    cron job). Exported via the billing schema index.
  - Config: `BILLRUN_TAX_RATE` (`z.coerce.number().min(0).max(100).default(8)`),
    `BILLRUN_TAX_VERSION` (`default("GST-2026")`), `BILLRUN_TAX_CATEGORY`
    (`default("GST")`) added to `lib/config.ts` + `.env.example`, plus the frozen
    `billRunTaxConfig` accessor. **No tax-rate catalog table** — v1's tax model is
    this single configured rate (deferred with the rating engine). The rate only
    parameterises a SQL `numeric` expression, never JS float.
  - Taxation stage (stage 6): `services/billing/taxation.ts` (`taxBill(tx, run,
    banId)`) — resolves the account's **unposted** trial bill
    (`customerBillRepository.findUnpostedBill`, `ref_inv_document_id IS NULL`
    latch; no bill ⇒ clean no-op), stamps `bill_run.ref_tax_rate_version` once via
    the new `billRunRepository.stampTaxRateVersion` (`IS NULL`-guarded ⇒
    idempotent, uniform per run), rerun-safely replaces the bill's tax items
    (`customerBillTaxItemRepository.replaceForBill` — `DELETE` + `INSERT ...
    SELECT` computing `tax_amount = round(subtotal * :rate / 100, 2)` **in SQL
    `numeric`**, half-up, never JS float), then recomputes totals
    (`customerBillRepository.recomputeTotals` — `tax_total` = the SQL `SUM` of the
    items, `total_amount = subtotal + tax_total`, also in SQL). Wired into
    `handle-stage-signal.ts` as a **side effect** (same shape as bm05's
    Aggregation, not an outcome override): a `DONE` `taxation` signal for a
    `PROCESSING` account triggers `taxBill` inside the same transaction; a
    `FAILED`/replayed/other-stage signal never reaches it, and a posted bill is
    never re-taxed (every write is latch-guarded).
  - Customers & Bills tab: `CustomerBillRow` gains `taxItems[]`
    (`CustomerBillTaxItemRow`); `services/billing/read/list-account-bills.ts`
    joins the tax items (`customerBillTaxItemRepository.listForRun`) and groups
    them per bill; `components/billing/customer-bill-table.tsx`'s `<details>`
    expander gains a **Tax** section (each item as `{category} @ {rate}% →
    {amount}`) and a tax-inclusive total.
  - Tests: `customer-bill-tax-item-schema.test.ts` (structural incl. the
    composite FK), `taxation.test.ts` (stamp/replace/recompute order, unposted-bill
    no-op, posted-bill never-taxed, configured rate/category passthrough),
    `handle-stage-signal.test.ts` extended with the Taxation side-effect (DONE
    triggers it; FAILED/replay/PENDING/other-stages don't), `list-account-bills.test.ts`
    extended for the tax-item grouping, `config.test.ts` extended (ENV_KEYS +
    full-config `toEqual` + `billRunTaxConfig` defaults/override/out-of-range).
    `typecheck`/`lint`/`format:check` clean; full DB-free vitest run passes
    except the same pre-existing date-drift set (246/250 files, 2539/2553 tests;
    4 files/14 tests failing — `tests/actions/{create-order,resume,suspend,
    terminate}-subscription*`, confirmed via `git status`/`git diff` that bm06
    touched none of them).

- **bm07 — Verification, Uncharged & Errors (+ Audit) tabs**
  (`specs/bm07-verification-uncharged-errors.md`). **No new table.**
  - Verification (stage 6): `services/billing/verify.ts` (`verifyAccount(tx,
    run, banId)`) — the last stage stops being bm04's record-and-advance
    pass-through and becomes an app-computed override (like Validation/
    Collection), wired into `handle-stage-signal.ts` as a fourth
    stage-specific `effective` branch. v1 is minimal (no rating, no prior-
    period baseline ⇒ variance/plausibility deferred): it **always records
    `DONE`** (never fails/blocks the run) plus, only when the single cheap
    backstop fails (the account's unposted bill `total_amount <= 0`, computed
    in SQL `numeric` via the new
    `customerBillRepository.findUnpostedTotalForVerification`), a **`SOFT`
    finding on that same stage row** (`error_code = 'NON_POSITIVE_TOTAL'`) —
    findings are `SOFT` stage rows, not a new table. A `SOFT` finding still
    lets the account reach `PROCESSED` (`advanceAccountStatus` unchanged —
    SOFT is neither HARD nor INFRA).
  - Uncharged read/tab: `services/billing/read/list-uncharged.ts` →
    `billRunAccountRepository.listExcludedForRun` (join `bill_run_account`
    `status = 'EXCLUDED'` → `billing_account` name/`ref_financial_account_id`
    + `bill_run` period). `UnchargedRow` (`types/billing.ts`) carries reason
    (`error_code`, `PARTIAL_PERIOD`), the uncharged window (run period), and
    `indicativeValue: null` (**no rating source in v1 → rendered "—"**).
    `components/billing/uncharged-table.tsx` (`UnchargedTable`, server
    component, info/neutral "revenue queue" treatment) deep-links each row to
    `/accounts/transactions?fa=…&ban=…` ("Manual DBN/ADJ"); CSV via
    `actions/billing/export-uncharged.action.ts`
    (`billrun_view:READ`, unaudited, bm02 `csvField`/`Blob` pattern) +
    `ExportUnchargedButton`.
  - Errors read/tab: `list-errors.ts` →
    `billRunAccountRepository.listErrorsForRun` (`DISTINCT ON (account)
    ORDER BY attempt DESC, bill_run_account_stage_id DESC` — the sequence-
    monotonic id is the tiebreaker for HARD rows sharing a top attempt — over
    `bill_run_account_stage` `error_class = 'HARD'` inner-joined to the account
    `status = 'PROCESSING_FAILED'` + name).
    `ErrorRow` (`types/billing.ts`); `errors-table.tsx` (`ErrorsTable`,
    destructive "blocking" treatment, `ErrorClassBadge` + stage/code/detail +
    an **inert "Rerun these accounts"** affordance — the action lands in bm08).
  - Audit read/tab: `list-run-audit.ts` → new
    `auditLogRepository.findByTargetId(db, runId)` (the platform `AUDIT_LOG`
    read filtered to `target_id = runId`, newest first, same actor join as
    `findFiltered`). `audit-table.tsx` (`AuditTable`) reuses the platform
    `AuditLogTable`/`AuditLogRow` unchanged (code-standards §4.8 — never fork
    a table); the run's `BILL_RUN_*` events (materialize/trigger, later
    rerun/approve/cancel) all stamp `targetId = billRunId`.
  - Wiring: `run-detail-tabs.tsx` renders the three previously-inert
    placeholders (`PlaceholderPanel` removed); `[runId]/page.tsx` reads each
    tab's data only for its own active `?tab=` (same idiom as bm05's
    Customers & Bills) and threads `getAppTimezone()` for the Audit table.
  - Tests: `verify.test.ts` (clean DONE with no bill / positive total; SOFT on
    non-positive; keyed read), `list-uncharged.test.ts`, `list-errors.test.ts`,
    `list-run-audit.test.ts`, `export-uncharged.action.test.ts` (route × level,
    CSV header/rows, blank indicative value, malformed-runId reject),
    `uncharged-table.test.tsx` (rows/reason/window, "—", the fa+ban deep link,
    empty state), `errors-table.test.tsx` (rows, disabled rerun affordance,
    empty state), `handle-stage-signal.test.ts` extended (verification uses
    `verifyAccount`'s SOFT outcome and still reaches PROCESSED), and
    `bill-run-detail-page.test.tsx` extended (each new read is fetched only for
    its own tab). `typecheck`/`lint`/`format:check` clean; the affected billing/
    audit suites pass (27 files / 183 tests in the bm07 slice).

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

## Post-review hardening (bm03–bm05)

Fixes from a code review of the bm03/bm04/bm05 diffs (only still-valid issues;
each verified against current code):

- **Stage error diagnostics are preserved (but transients still recorded)** —
  `handleStageSignal` stamps `bill_run_account.error_code`/`error_detail` from
  the signal unless the account was ALREADY terminal (`PROCESSING_FAILED`/
  `EXCLUDED`) before it, so a stray later signal cannot wipe the failure reason,
  while a non-terminal INFRA/SOFT failure still records its diagnostics (not
  blank). `updateStatus` omits the error fields when not provided. *(Second
  round refined the initial `newlyFailed`-only rule, which dropped transient
  diagnostics.)*
- **Malformed M2M JSON → 422, not 500** — both Route Handlers wrap
  `request.json()` so a body-parse error maps to `validationFailed` (422).
- **Stage-signal body is strict** — `stageSignalBodySchema` is `strictObject`,
  so an undeclared charge field (`amount`) is rejected 422 (code-standards §5.5)
  rather than silently dropped; route test asserts it.
- **Stage rows record no fabricated start** — a completion signal writes
  `started_at = null` (only `ended_at` is real), not a false zero-duration.
- **Snapshot insert is batched** — `insertSnapshot` chunks rows (1000/stmt) so a
  large cycle can't exceed Postgres's 65535 bind-parameter limit.
- **Deterministic active-account order** — `findActiveByCycleId` orders by
  `billing_account_id` (matching `findByFinancialAccountId`).
- **Trigger dialog UX** — a failed action keeps the confirm panel open so the
  inline error stays visible; Cancel restores focus to the Run button.
- **Test hardening** — the partman bootstrap integration test guards
  `BOOTSTRAP_DATABASE_URL` with `assertTestDatabaseUrl`; the double-trigger test
  asserts the exact snapshot row count.
- **Docs** — bm03 spec trigger order matches `triggerRun` (startExecution
  before markProcessing), dialog copy/inline-error wording corrected; specs use
  repo-relative "Grounded in" paths (no local `F:/…` prefix); tracker's
  delivered bm04/bm05 no longer sit under "In Progress: None" and the
  test-result summaries no longer read "green" while failures remain.

Skipped (verified not still-valid): the trigger's in-txn engine call (a
documented flagged decision, not a bug); `BILLRUN_ENGINE_URL` HTTPS-only (spec
mandates a plain URL; the outbound path is private-network); `import.meta.dirname`
in the partman bootstrap (works under the repo's `tsx`/ESM run mode); the
default-partition index removal (`period_partition` is not a leading key of the
PK/unique, so the standalone index is not redundant); `inArray` chunking on
inventory reads (single-param SELECTs, empty-input already guarded).

### Second round (review of the remediation + re-scan of the three commits)

- **Aggregation writes a bill only for an in-progress account** —
  `handleStageSignal` reads the account status BEFORE the aggregation write and
  gates `aggregateBill` on `status === 'PROCESSING'`, so an untrusted M2M
  `aggregation`+`DONE` for an `EXCLUDED` (scoped-out), still-`PENDING` (never
  validated), or already-terminal account no longer produces a trial
  `customer_bill`.
- **Terminal stage completes only a started account** — `advanceAccountStatus`
  requires the account to be past `PENDING` before a `verification` DONE/SKIPPED
  can mark it `PROCESSED`; a lone terminal-stage signal on a `PENDING` account
  advances it to `PROCESSING`, not a false `PROCESSED`.
- **Constant-time token compare guards BYTE length** — `serviceTokenMatches`
  (and the mirrored `csrfTokensMatch`) compare `Buffer` byte lengths, not
  `String.length` (UTF-16 units), so a crafted multibyte token returns a clean
  reject instead of a `timingSafeEqual` RangeError → 500.
- **status-push body is strict; unsupported field dropped** —
  `statusPushBodySchema` is `strictObject` (rejects charge/unknown fields 422,
  matching stage-signal) and no longer declares `error_detail`, which was
  validated then silently discarded (v1 has no `bill_run` column or read
  surface for it; it returns with those).
- **Trial delete reverted to latch-only** — the first round's added
  `category = 'trial'` predicate was removed: with at most one `customer_bill`
  per `(run, ban, period)` UNIQUE, filtering to `trial` would skip a non-trial
  unposted row and then collide on `insertTrial`. The delete keys exactly on the
  UNIQUE + the `ref_inv_document_id IS NULL` latch, matching the bm05 spec.

## Post-review hardening (bm06)

Fixes from a code review of the bm06 diff (only still-valid issues; each verified
against current code):

- **Tax-item FK is `ON DELETE CASCADE`, not `RESTRICT`** — bm05's rerun-safe
  trial re-derivation (`customerBillRepository.deleteTrial`) deletes the whole
  unposted `customer_bill`; once a taxation pass had written
  `customer_bill_tax_item` rows, a `RESTRICT` FK would block that delete and break
  the rerun. CASCADE drops the stale items with the bill. Posted bills are never
  deleted (`deleteTrial`'s `ref_inv_document_id IS NULL` guard), so a finalized
  bill's items are never cascade-removed (Inv. #4). Changed in both the schema
  and `0030` (not yet applied anywhere — edited in place, not a new migration).
- **Out-of-order taxation is rejected, not silently recorded** — a `DONE`
  `taxation` signal that arrives before Aggregation created the bill used to
  record the stage row DONE and no-op, leaving the account permanently "taxed"
  with zero tax. `taxBill` now throws `CONFLICT` when no unposted bill exists, so
  the whole ingest transaction rolls back (the stage row is never committed) and
  the engine retries after Aggregation. Replay safety is unaffected (a duplicate
  is still caught by the idempotency-latch unique violation before `taxBill`
  runs). (bm11 posting will refine null-bill handling to distinguish an
  already-posted bill's late signal — an idempotent no-op — from a missing one.)
- **`BILLRUN_TAX_RATE` rejects >2 decimal places** — the rate is cast/stored as
  `numeric(5,2)`, so a value like `8.125` would be silently rounded on store and
  no longer match the amount it was computed from. The config schema now fails
  fast at boot on higher precision (0–100 bounds unchanged).
- **Customers & Bills read uses one snapshot** — the bill totals and the tax
  items are now read inside a single `repeatable read`, `read only` transaction,
  so they can't straddle a concurrent taxation commit (a summary `tax_total` of
  0.00 next to a just-inserted tax line). The concurrent-commit regression is a
  DB-gated integration test (not runnable here — no local Postgres); a unit test
  asserts both reads share one tx handle.

Skipped (verified not still-valid or out of scope):

- **`formatCurrency` `Number()` precision** — it is the single mandated platform
  money formatter (code-standards §4.4); the actual bm06 values (synthetic stub
  subtotals in the low thousands) never approach `Number`'s precision limit, and
  the flagged `999999999999999.99` is not a value this system produces. A
  decimal-safe formatter would be a platform-wide change to `lib/formatters.ts`
  with all call sites, out of bm06's scope; forking a billing-only formatter
  would violate the one-formatter rule.
- **`FOR UPDATE` on the taxation bill lookup** — redundant: `handleStageSignal`
  already holds `SELECT … FOR UPDATE` on the parent `bill_run` row for the whole
  transaction (`findByIdForUpdate`), and a `customer_bill` belongs to exactly one
  run, so all mutations to the run's bills are already serialized.
- **Persist rate/category on `bill_run` (not just version)** — the spec stamps
  only `ref_tax_rate_version` for provenance (one version per run, already
  uniform); adding rate/category columns is a schema change beyond bm06's spec,
  and a rate change is expected to accompany a version bump (operator
  discipline). Revisit when a real tax-rate catalog lands.
- **contact-manager add-form Save button token** — out of bm06 scope; the Save is
  a shared confirm control (CTA) used by both add and edit via one form
  component, and the "add-new → primary" rule (commit c186385) applies to the
  reveal trigger ("Add contact", already `--action-primary-bg`), not the in-form
  Save. The requested add-vs-edit asymmetry has no design-doc basis.
- **activate-offering CTA comment** — out of bm06 scope; the referenced
  `ui-context-phase2` is stale, but the current `prodmgmt-ui-context.md` actually
  reserves `--action-cta-bg` for "New offering" and marks Activate as quiet, so
  merely rewording the comment while preserving its "accent reserved for this
  confirm" claim would perpetuate a statement the current doc contradicts — a
  product design decision, not a comment tweak.

### Second round (high-effort recall review of the bm06 diff + GST rename)

- **`replaceForBill`'s DELETE now carries the finalization latch too** — its
  DELETE previously keyed only on `(ref_customer_bill_id, period_partition)`
  while its INSERT and `recomputeTotals` both guarded `ref_inv_document_id IS
  NULL`. Added an `EXISTS` guard on the parent bill so the DELETE cannot wipe a
  posted bill's tax items either — the write is now self-protecting (enforces
  Inv. #4 even if a future caller passes a posted bill's id), not reliant on the
  caller having pre-filtered via `findUnpostedBill`.
- **`customerBillTaxItemRepository.listForRun` joins on the full composite key**
  — the `customer_bill_tax_item` → `customer_bill` join now matches
  `(customer_bill_id, period_partition)`, not just the id, so Postgres can prune
  both partitioned tables to the run's period instead of scanning all 84 monthly
  partitions (correctness was already fine — ids are sequence-unique — this is
  partition-pruning + composite-key consistency).
- **Empty `BILLRUN_TAX_RATE` no longer silently means 0%** — `z.coerce.number("")`
  is `0`, so a present-but-blank `BILLRUN_TAX_RATE=` would have taxed every bill
  at 0% instead of applying the `8` default. Wrapped in `z.preprocess` mapping
  `"" → undefined` so the default applies; a new config test locks it.
- Verified-and-dropped (no change): the `Promise.all` of two reads inside the
  `repeatable read` transaction is **safe** — the driver is postgres.js (not
  node-postgres), whose reserved `begin` connection pipelines concurrent queries;
  drizzle awaits `setTransaction` before the callback, so both reads share one
  snapshot. The `z.coerce` 2-dp `refine` tolerance (`1e-9`) is safe (FP error for
  0–100 two-decimal values is ~1e-13). The index-based React key on tax lines has
  no observable effect (static server-rendered list, no per-item state).

`typecheck`/`lint`/`format:check` clean; the 5 bm06 test files pass (75 tests).

- **bm08 — Rerun (full & partial)** (`specs/bm08-rerun.md`). **No new table.**
  - Rerun service: `services/billing/rerun-run.ts` (`rerunRun`) — one
    `db.transaction`, pre-approval only (`findByIdForUpdate` row lock →
    `PROCESSED`/`PROCESSING_FAILED` else typed `NOT_RERUNNABLE`): (1) **audit
    first** — one `BILL_RUN_RERUN` audit row written **before** the engine
    re-trigger (`beforeData.priorTotals` = the SQL-summed current bill total of
    the rerun accounts via `customerBillRepository.sumTotalsForAccounts`;
    `afterData = { accounts, fromStage, attempt, reason }`); (2)
    `attempt_count` set to one uniform new attempt (max + 1) for the selected
    accounts back to `PROCESSING` (`billRunAccountRepository.setAttemptForRerun`,
    clearing prior diagnostics); (3) later stages invalidated **implicitly** via the
    attempt-keyed `bill_run_account_stage` latch (no stage-row DELETE —
    prior-attempt rows stay as history); (4) trial bills re-derived from the
    chosen stage onward (`aggregateBill`/`taxBill`, bm05/bm06) under the
    `ref_inv_document_id IS NULL` guard (rerun from `verification` re-derives
    nothing; from `taxation` re-taxes only; from `aggregation`/`collection`/
    `validation` rewrites then re-taxes — gated on the `STAGES` index); (5)
    claim release/re-claim is a documented v1 no-op; (6) the engine (stub) is
    re-triggered scoped to the rerun `ban_ids` + new attempt (in-txn, bm03
    rollback pattern → `ENGINE_UNREACHABLE`), then the run loops back to
    `PROCESSING` (`billRunRepository.markRerunProcessing` — refreshed derived
    counters + new execution ref, never `processed_at`/`gl_event_at`/
    `triggered_by`). Typed result union `ok | NOT_RERUNNABLE |
    NO_ACCOUNTS_SELECTED | ENGINE_UNREACHABLE`.
  - **Finalization guard is absolute** — `EXCLUDED` and posted
    (`ref_inv_document_id` set, `customerBillRepository.listPostedAccountIds`,
    always empty in v1) accounts are dropped from the eligible set, so nothing
    finalized is ever invalidated or re-derived (architecture Inv. #4). The
    conditional `DELETE … WHERE ref_inv_document_id IS NULL` in
    `aggregateBill` is the belt-and-suspenders DB-side backstop.
  - Action + validation: `actions/billing/rerun-run.action.ts` (`'use server'`,
    `billrun_operate:EDIT` → parse → `rerunRun` → `revalidatePath` the run +
    list pages on success) + `validation/billing/rerun-run.schema.ts`
    (`{ billRunId, accountIds[] (BAN-format, defaults []), fromStage
    (Validation→Verification), reason (trimmed, non-empty) }`; empty reason ⇒
    `VALIDATION_ERROR`, matching the sibling `triggerRunAction` convention).
  - Audit event: `BILL_RUN_RERUN` (category `"Change"`) added to
    `AUDIT_EVENT_TYPES` (`types/audit.ts`) + `AUDIT_EVENT_CATEGORY_MAP`
    (`types/audit-log.ts`) + explicit coverage assertion. Ripple:
    `tests/components/audit-log-filters.test.tsx` option count 64 → 65.
  - Components: `components/billing/rerun-dialog.tsx` (`RerunDialog`, client
    inline-confirm leaf — preview + stage `<select>` + mandatory reason
    `<textarea>` + submitting/error, `router.refresh()` on success, following
    the `TriggerRunDialog` shape). Wired into the **Errors tab** (`ErrorsTable`
    now takes `runId` + `canOperate`, replacing bm07's inert button with a
    `RerunDialog` scoped to the failed accounts) and a **run-level control** on
    the detail page header (`canOperate && rerunnable` — empty `accountIds` =
    all eligible). `run-detail-tabs.tsx`/`[runId]/page.tsx` thread the new
    `canOperate` (`meetsLevel(permissionMap[BILLRUN_OPERATE], EDIT)`).
  - Repositories: `bill-run-account.repository.ts` (`listForRerun`,
    `setAttemptForRerun`), `customer-bill.repository.ts`
    (`listPostedAccountIds`, `sumTotalsForAccounts`), `bill-run.repository.ts`
    (`markRerunProcessing`).
  - Tests: `rerun-run.service.test.ts` (audit-before-retrigger ordering; scoped
    attempt bump; finalization guard drops posted accounts; attempt increment +
    run loop; per-stage re-derivation; `PROCESSING_FAILED` rerunnable;
    `APPROVED`/unknown → `NOT_RERUNNABLE`; `NO_ACCOUNTS_SELECTED`;
    `ENGINE_UNREACHABLE` rollback; unrelated-error passthrough),
    `rerun-run.action.test.ts` (route × level, empty-reason `VALIDATION_ERROR`,
    default `accountIds`, revalidate-on-success), `rerun-dialog.test.tsx`
    (preview, Validation→Verification options, mandatory reason gate, submit +
    success, typed-failure surface, run-level trigger), `errors-table.test.tsx`
    rewritten (rerun affordance wired for an operator, hidden for view-only),
    `bill-run-detail-page.test.tsx` extended (stubs the header `RerunDialog`),
    `audit-log.test.ts` + `audit-log-filters.test.tsx` ripples.
    `typecheck`/`lint`/`format:check` clean; the bm08 + touched
    billing/audit/db slice passes (304 tests) except the same pre-existing
    env-dependent `trigger-run.service.test.ts` failure noted below (it mocks
    all repos and never touches `trigger-run.ts`, so bm08 cannot affect it).

- **bm09 — Accounts-side INV & posting enablement (cross-module)**
  (`specs/bm09-accounts-inv-enablement.md`). Additive only — every write is a
  new sequence/row/CHECK-membership; no existing `document`/`reason_code`/
  `gl_mapping` row or Accounts posting/period-close behavior changed.
  - Migration `0031_add_inv_document_type.sql` / `0032_validate_inv_document_
    type_check.sql` (the `0014` NOT-VALID/VALIDATE idiom): `CREATE SEQUENCE
    billing.document_inv_seq`; both `document_doc_type_check` and
    `reason_code_doc_type_check` dropped and re-added to admit `'INV'`.
    `db/schema/billing/documents.ts`/`catalogs.ts` updated to match (physical
    DDL of record is the migration; the Drizzle declarations are typing-only
    mirrors, same convention as every hand-authored migration in this module).
  - `types/accounts.ts` `DOC_TYPES` gains `INV` (six members now);
    `db/repositories/accounts/document.repository.ts` `DOC_SEQUENCE_NAME.INV
    = "billing.document_inv_seq"`. `z.enum(DOC_TYPES)`
    (`validation/accounts/reason-code.schema.ts`) and the Type filter/select
    options (`components/accounts/documents-table.tsx`,
    `reason-code-form.tsx`, both already iterating `DOC_TYPES`) pick up `INV`
    automatically; `documentIdSchema`'s ID-format regex gained the `INV`
    alternative explicitly (not array-driven).
  - `db/seeds/accounts/seed-reason-codes.ts` — `STANDARD_INVOICE`
    (`docType: 'INV'`, `postingNature: 'revenue'`,
    `autoPostLimit: '999999999999.99'`) so `postDocument`'s
    `totalAmount > auto_post_limit` gate never trips: an INV **auto-posts
    from `draft`**, never routing to `pending_approval` — the run-level
    four-eyes (bm10) is the sole second signature, and each INV's
    `created_by` is the approver. No new GL mapping rows — the existing
    `ledger_role/receivables`, `system_account/sys.revenue.{ccy}`, and
    `system_account/sys.tax_payable.{ccy}` rows (already seeded for DBN)
    resolve unchanged.
  - `services/accounts/leg-templates.ts` — `INV_LEG_TEMPLATES`, structurally
    identical to `DBN_LEG_TEMPLATES` (`charge` = A/R debit + revenue credit;
    `release` reused as the tax line's disambiguating key = A/R debit + tax-
    payable credit, the same `(doc_type, line_kind)`-reuse precedent DBN/DEP/
    ADJ already established). `post-document.ts` needed **no change** — it
    already resolves the sys account generically from the reason code's
    `posting_nature` and dispatches legs via `resolveLegTemplate(docType,
    lineKind)`. bm11 owns constructing the two `document_line`s per INV.
  - Period-close guard: `bill-run.repository.ts` gains
    `findActiveForPeriod(db, period, currency)` — `bill_run` joined to its
    `customer_bill`s (for currency via `billing_account`, single-currency per
    cycle in v1) where `to_char(gl_event_at, 'YYYY-MM') = period` and
    `status NOT IN ('COMPLETED','CANCELLED')`. `services/accounts/period-
    close.ts`'s `closePeriod` calls it **before** touching the accounting
    period, inside the same transaction; a non-empty result returns a new
    typed `{ ok: false, code: 'BILL_RUN_IN_PROGRESS', activeRunIds }` instead
    of closing. `components/accounts/close-period-button.tsx`'s
    `describeError` surfaces it as "N bill run(s) still posting into
    {period}."
  - Guardrail: `tests/accounts/bm09-inv-enablement.integration.test.ts`
    (DB-gated, not run in this environment — no local Postgres reachable,
    same constraint noted throughout this tracker) — an INV under
    `STANDARD_INVOICE` auto-posts directly from draft
    (`document_inv_seq` yields `INV00000001`), legs balance (A/R debit =
    revenue credit + tax credit) via the existing mappings, a DBN under
    `MANUAL_CHARGE` still posts unaffected (**[CRITICAL]** existing-Accounts-
    unchanged), and the period-close guard blocks then allows closing once
    the run reaches `COMPLETED`. Deliberately named `bm09-*`, not `vNN-*` —
    that pattern is the closed, audited V1-V14 Accounts module-invariant
    sequence (`tests/accounts/verification-audit.test.ts`'s "no orphan
    V-test" gate); this cross-module billing unit isn't one of the 14
    architecture.md §6 invariants it maps, and an earlier `v15-*` name
    tripped that gate.
  - Ripple (found via a full-codebase sweep for hardcoded "5 document types"
    assumptions, since `types/accounts.ts DOC_TYPES` is Accounts' own source
    of truth): `tests/accounts/grep-gates.test.ts`'s inv. #19 gate
    (regex now expects six types), `tests/components/documents-table.test.tsx`
    (filter option count 6→7), `tests/accounts/transactions-documents-
    list.integration.test.ts` (`DOC_TYPES` length 5→6),
    `tests/db/billing-schema.integration.test.ts` (the per-doc-type sequence
    loop now covers `INV` too). `context/accounting-management/acctmgmt-
    code-standards.md` §9's Result-code catalog gained `BILL_RUN_IN_PROGRESS`
    (49→50 codes, `tests/accounts/grep-gates.test.ts`'s catalog-count gate
    updated to match) since `period-close.ts` is under `services/accounts/**`.
  - `typecheck`/`lint`/`format:check` clean; full DB-free `vitest run`
    (2612 tests) passes except the same pre-existing failures already on
    `dev1` before this unit — confirmed via `git stash`: the 4 hardcoded-
    date-drift action-suite files (`create-order`/`resume`/`suspend`/
    `terminate-subscription`), `tests/services/billing/
    trigger-run.service.test.ts`'s env-var-dependent failure (documented in
    this tracker's bm05 session notes), and `tests/accounts/grep-gates.test.ts`'s
    one BAN-narrowing false positive on `db/repositories/billing/
    bill-run-account.repository.ts` (a file this unit never touches). bm09
    touches none of those files.

## Post-review hardening (bm07)

Fixes from a high-effort code review of the bm07 diff:

- **Errors read is deterministic** — `billRunAccountRepository.listErrorsForRun`'s
  `DISTINCT ON (account)` gained a `desc(bill_run_account_stage_id)` tiebreaker
  after `desc(attempt)`: an account can carry HARD stage rows on two stages at
  the same caller-supplied `attempt`, and the sequence-monotonic id now picks the
  last-recorded failure instead of an arbitrary one (the Errors tab no longer
  flips stage/code between identical reads).
- **A SOFT verification finding no longer stamps a PROCESSED account** —
  `handleStageSignal` now stamps `bill_run_account.error_code`/`error_detail`
  only on a genuine FAILURE outcome (`effective.status === 'FAILED'` — HARD
  terminal / INFRA transient); a DONE/SKIPPED outcome clears them. A
  `verification` SOFT *finding* lives on the stage row (its intended surface), so
  a successfully-`PROCESSED` account never carries a stale, contradictory
  `NON_POSITIVE_TOTAL` code. (A caller-signalled `FAILED`+SOFT on a pass-through
  stage still records its diagnostics, unchanged.)
- **The Uncharged recovery link no longer dead-ends** — `/accounts/transactions`
  is guarded by `accounts_transactions:READ`, which a `billrun_view`-only
  principal (the Billing Viewer role) lacks. `BillRunDetailPage` now resolves
  `canRecover = meetsLevel(permissionMap[accounts_transactions], READ)` and
  threads it through `RunDetailTabs` → `UnchargedTable`; the "Manual DBN/ADJ"
  affordance renders as a plain hint (not a `/no-access` link) when the viewer
  can't reach Transactions (show/hide only — the route still re-checks
  server-side).
- **CSV export mechanics de-duplicated** — extracted `lib/csv.ts` `buildCsv(header,
  rows)` (header + rows → `csvField`-escaped, CRLF, trailing newline), now used by
  both `export-uncharged`/`export-runs` actions; and `lib/download.ts`
  (`downloadCsv`/`triggerBlobDownload`) collapsing the hand-rolled Blob-download
  dance previously copy-pasted across the two billing export buttons **and**
  `components/accounts/journal-export-button.tsx`. The audit-log repository's
  `findByTargetId` (bm07) and `findFiltered` now share one `AUDIT_ROW_COLUMNS`
  projection + `toAuditLogRow` mapper (no drift between the platform audit page
  and the run Audit tab).

Skipped (verified not worth the churn):

- **`verifyAccount`'s bill read runs before the idempotency-latch insert** — the
  stage row's recorded status/error IS the app-computed outcome, so the effect
  must be computed before the insert; deferring it would either violate the
  insert-first latch (architecture Inv. #5) or require the pre-existence check
  the invariant forbids. Matches the pre-existing `validateAccount` shape; the
  wasted read only occurs on a replayed signal (one indexed SELECT).
- **`listExcludedForRun` joins `bill_run` for the run-constant window** — a single
  in-query join (not per-row I/O); the per-row window is spec-mandated (the
  Uncharged read "returns the uncharged window (run period)") and keeps the read
  self-contained for both the page and the export action call sites. Threading
  the period from two callers to drop one cheap join is not a net simplification.

`typecheck`/`lint`/`format:check` clean; the bm07 + touched audit/accounts test
files pass (31 files / 217 tests in the slice).

## Post-review hardening (bm08)

Fixes from a high-effort code review of the bm08 diff (run against a throwaway
Postgres — migrations applied, the new repo SQL exercised directly; the new
`::numeric(18,2)::text` sum returns `"0.00"` on an empty match):

- **[CRITICAL] Inline re-derivation no longer throws an untyped error that rolls
  back the whole rerun, and no longer bills an unvalidated account.** The loop
  re-derived every selected account unconditionally: (a) a rerun from `taxation`
  of an account with no trial bill made `taxBill` throw `CONFLICT` (an `AppError`,
  not the `EngineUnreachableSignal` the outer catch handles), so the whole
  transaction rolled back and `rerunRun` **rejected** instead of returning a typed
  result — the Errors tab feeds exactly the `PROCESSING_FAILED` accounts, so this
  was reachable; (b) a rerun from `validation` of an account that failed at
  Validation called `aggregateBill` directly, **writing a trial `customer_bill`
  for an account that never passed the app-computed Validation gate** (or throwing
  `notFound` on an unresolvable profile). Fix: re-derive inline **only for
  accounts that already have an unposted bill** (`customerBillRepository.listUnpostedBillAccountIds`)
  — i.e. accounts that previously reached Aggregation. An account with no bill is
  attempt-bumped and left for the re-triggered engine to re-validate and create
  through the single validated `handle-stage-signal` path; `taxBill` is never
  called with no bill to tax. This closes review findings #1 and #2 and mitigates
  the double-derivation concern (#4) — inline re-derivation is now purely a
  delta-refresh of existing bills, with the engine re-signal as the authoritative
  create/validate path.
- **Derived counter cache is a shared helper (Inv. #12).** Extracted
  `computeRunCounters(accountStatuses)` into `services/billing/compute-run-status.ts`;
  both `handle-stage-signal.ts` (the stage-signal recompute) and `rerun-run.ts`
  (the loop-back) now call it instead of copy-pasting the
  `filter(s === 'PROCESSED'/'PROCESSING_FAILED')` derivation — so a new terminal
  `AccountStatus` is handled in one place and stored can never disagree with
  derived on one path only.
- **One fewer read; independent reads parallelised.** `rerun-run.ts` now issues
  `listForRerun` + `listPostedAccountIds` + `listUnpostedBillAccountIds` together
  (`Promise.all`, all keyed only on the run) and computes the post-bump counters
  **in-memory** (selected accounts are now `PROCESSING`; every other account keeps
  the status just read) — dropping the extra `listStatusesForRun` full-table
  re-read it did late in the transaction while holding the row lock.
- **`accountIds` is length-capped.** `rerun-run.schema.ts` adds `.max(5000)` so a
  crafted action call cannot build an unbounded `IN (…)` from caller input
  (duplicates already collapse in the service's Set-based filter).
- **`RerunDialog` uses the shared `Button`.** The trigger/confirm/cancel buttons
  now render `components/ui/button.tsx` (`variant="destructive"`/`"outline"`)
  instead of hand-rolled `var(--color-danger-600)` utility strings, so they track
  the design-system destructive treatment (§4.7) like every other Button.
- **Uniform rerun attempt.** `setAttemptForRerun` (renamed from
  `incrementAttemptForRerun`) now SETs every selected account's `attempt_count`
  to the same new attempt (`max(selected) + 1`) instead of a per-row `+ 1`, so a
  partial rerun of accounts on divergent attempts ends them all on one attempt
  that matches the audited value and the engine's stage signals.
- **Errors-tab rerun gated on rerunnability.** The Errors-tab rerun control is
  now gated on `canRerun = canOperate && rerunnable` (threaded as a `canRerun`
  prop through `RunDetailTabs` → `ErrorsTable`), matching the run-level header
  control — so the control is never shown on a non-rerunnable run where it would
  always hit the service's `NOT_RERUNNABLE` guard.
- **`markRerunProcessing` clears `processed_at`.** Looping the run back to
  `PROCESSING` now nulls the prior attempt's `processed_at` (re-stamped by
  `recomputeStatus` on completion) so a re-processing run carries no stale
  completion timestamp.
- **`RerunDialog` confirm panel role.** The inline confirm panel is `role="group"`
  (a labelled control cluster), not `role="alertdialog"` — it is not modal and
  traps no focus, so `alertdialog` overstated its semantics.
- **Not changed (reviewed, intended):** the run-level "Rerun" control
  re-processing already-`PROCESSED` accounts is the spec's "rerun all" (permission
  + mandatory-reason + confirm gated) — verified as intended, not a footgun. The
  long per-account transaction on a large run-level rerun (holding the `bill_run`
  lock, blocking concurrent M2M signals) is a real scaling limit inherited from
  the bm05/bm06 per-account shape; left as-is for v1 (stub engine, small demo
  runs) and flagged for a batched re-derivation when a real engine + large cycles
  land. `realEngineClient`'s timeout-then-`json()` window is pre-existing bm03
  code, out of scope for the bm08 change set.

`typecheck`/`lint`/`format:check` clean; the bm08 + touched billing/audit slice
passes (29 files / 204 tests, plus the full DB-free suite green except the known
pre-existing hardcoded-date-drift action suites).

- **bm10 — Approve (four-eyes gate)** (`specs/bm10-approve.md`). **No new
  table.**
  - Pre-approval checks: `services/billing/pre-approval-checks.ts`
    (`runPreApprovalChecks`, five pure-ish reads returning `{ check, pass,
    remediation }[]`, run in parallel except four-eyes which is a pure sync
    check) — **period open** (`accountingPeriodRepository
    .findByPeriodAndCurrency(periodKeyFor(gl_event_at), currency)` for every
    currency among the run's postable bills, absent row = open); **GL
    mappings resolvable** (new `ledgerRepository.resolveGlCodeByName` —
    joins `pgledger_accounts_view` → bm09's `gl_resolution_view` by account
    name — checked for `sys.revenue.{ccy}`/`sys.tax_payable.{ccy}` per
    currency); **no zero/negative totals** (`customerBillRepository
    .countNonPositivePostable`, backstop only — Scoping already excludes
    zero-charge accounts); **four-eyes** (`run.triggeredBy !== approverId`
    — `triggered_by` is unchanged by a rerun, bm08 resolved decision, so
    this always compares against the *original* trigger actor, matching the
    spec's "final attempt" framing and the DB backstop); **all accounts
    terminal** (`billRunAccountRepository.listStatusesForRun`, a backstop —
    a `PROCESSED` run's accounts are already frozen, since `handleStageSignal`
    rejects any M2M signal once the run leaves `PROCESSING`). The three new
    `customerBillRepository` reads (`listPostableCurrencies`,
    `countNonPositivePostable`, `sumPostableTotalForRun`) all key
    "postable" as **the bill belongs to a `PROCESSED` account** — the only
    status besides `PROCESSING_FAILED`/`EXCLUDED` a terminal run can hold,
    and those two are exactly what approval marks `SKIPPED`.
  - Approve service: `services/billing/approve-run.ts` (`approveRun`), one
    `db.transaction`: `findByIdForUpdate` → guard `status = 'PROCESSED'`
    (else `NOT_APPROVABLE`) → `runPreApprovalChecks` — a failing four-eyes
    check short-circuits to its own `FOUR_EYES_VIOLATION` result (checked
    first, ahead of the other four, since it is the money-gate's namesake
    invariant); any other failing check(s) bucket under `CHECKS_FAILED`,
    which carries the COMPLETE re-check result (so the panel replaces its
    checklist wholesale and a now-passing check is cleared, not left stale) →
    `customerBillRepository.sumPostableTotalForRun`
    (the immutable `total_amount` stamp, SQL `SUM`, never a JS reduce) →
    `billRunAccountRepository.markSkippedForRun` (every
    `PROCESSING_FAILED`/`EXCLUDED` account → `SKIPPED`) →
    `billRunRepository.approve` (`PROCESSED → APPROVED`, stamps
    `approved_by`/`approved_at`/`total_amount`) →
    `insertAuditEvent(BILL_RUN_APPROVED)`. The `bill_run_approver_distinct_check`
    DB CHECK (bm02) is never actually hit in the normal flow — the service
    returns `FOUR_EYES_VIOLATION` before ever attempting the write — it
    remains the backstop per Inv. #8.
  - Action + audit: `actions/billing/approve-run.action.ts`
    (`billrun_approve:EDIT` → parse `{ billRunId }` → `approveRun` →
    `revalidatePath` the run, approve, and list pages on success only).
    `BILL_RUN_APPROVED` added to `AUDIT_EVENT_TYPES` (`types/audit.ts`) +
    `AUDIT_EVENT_CATEGORY_MAP` as `"Change"` (`types/audit-log.ts`) — a
    state transition, not a new entity.
  - Page + components: `app/(app)/billing/bill-runs/[runId]/approve/`
    (`page.tsx` guards `billrun_approve:EDIT`, awaits `params`, reads the
    live `getApprovePreview` — never cached — `loading.tsx`/`error.tsx`).
    `services/billing/read/get-approve-preview.ts` (`getApprovePreview`)
    resolves the final trigger actor's name + timestamp from the newest
    `BILL_RUN_TRIGGERED`/`BILL_RUN_RERUN` row in the run's audit trail
    (`auditLogRepository.findByTargetId`, already newest-first) — there is
    no dedicated `triggered_at` column, and a rerun never re-stamps
    `triggered_by`, so the audit trail is the correct source for "when the
    final attempt started." `components/billing/pre-approval-checks.tsx`
    (`PreApprovalChecks`, pass/fail rows + remediation, an icon paired with
    every state) and `components/billing/approve-and-post-panel.tsx`
    (`ApproveAndPostPanel`, client — names the trigger actor, disables
    Approve with a visible reason only for the four-eyes case specifically
    — not for any other failing check, matching the spec's literal "Approve
    disabled for that actor + reason" — then an inline confirm frames
    irreversibility with the postable count/total and the skipped count,
    the confirm submit in the danger role). The run detail page
    (`[runId]/page.tsx`) gains a `billrun_approve`-gated "Approve & Post"
    link in the header, shown only while `status = 'PROCESSED'` — the sole
    entry point into the new route (not explicitly listed in the spec's
    Implementation checklist, but without it the page is unreachable from
    the UI; added as a minimal, low-risk navigation-only change, documented
    here per the "record every resolution" rule).
  - Tests: `pre-approval-checks.test.ts` (all five checks, incl. the
    absent-period-row-is-open and multi-currency GL-mapping cases),
    `approve-run.service.test.ts` (stamps + SKIPPED + APPROVED + audit;
    `NOT_APPROVABLE` on non-PROCESSED/unknown; `[CRITICAL]` four-eyes
    rejects with no writes; `CHECKS_FAILED` carries the complete re-check
    result), `approve-run.action.test.ts` (route × level, incl. surfacing
    `FOUR_EYES_VIOLATION` unchanged), `pre-approval-checks.test.tsx` +
    `approve-and-post-panel.test.tsx` (component-level: self-approval
    disables Approve with a visible reason, irreversibility framing,
    success/failure states), `approve-page.test.tsx` (route × level
    matrix), `bill-run-detail-page.test.tsx` extended (the new link's
    show/hide), `route-manifest.test.ts` + `audit-log-filters.test.tsx`
    (65 → 66) ripples. `typecheck`/`lint`/`format:check` clean; the full
    DB-free `vitest run` slice touched by this unit passes (57 files / 370
    tests) except the same pre-existing, env-dependent
    `trigger-run.service.test.ts` failure documented in this tracker's bm05
    session notes (missing `DATABASE_URL`/`BETTER_AUTH_SECRET`/
    `BETTER_AUTH_URL` in this shell; confirmed unrelated — the file imports
    nothing bm10 touched).

- **bm11 — Post to the ledger** (`specs/bm11-post-to-ledger.md`). **No new
  table** — every column posting stamps was already reserved by bm02/bm05
  (`bill_run.posting_started_at`/`invoiced_at`/`completed_at`,
  `customer_bill.ref_inv_document_id`/`posted_attempt`/`charge_checksum`), so
  this unit is additive writes only, no migration.
  - Posting service: `services/billing/post-run.ts`. `postAccount(run, banId,
    actorId)` — the ENTIRE per-account write runs inside one `db.transaction`
    (Inv. #6, code-standards §1.5): (1) ONE joined `FOR UPDATE OF customer_bill`
    read (`customerBillRepository.lockBillForPosting`) returns the trial bill +
    the account's `attempt_count` + the billing-account GL fields in a single
    round-trip (replacing three sequential per-account reads) and serializes two
    concurrent resume/post attempts on the same account on the bill row — then
    skip if the bill already carries `ref_inv_document_id` (idempotent resume);
    (2) build one `INV`
    (`documentRepository.insert`, `STANDARD_INVOICE`, `createdBy` = the run's
    stamped `approvedBy` — bm09's resolved decision — `eventAt = gl_event_at`,
    `entryDate = scheduled_run_date`) with a `charge` line (= `subtotal`) and,
    only when `tax_total > 0`, a `release` tax line (bm09's `INV_LEG_TEMPLATES`,
    the raise-debit-note precedent for the optional-tax-line shape); (4)
    `postDocument(tx, invId, actorId)` — auto-posts under `STANDARD_INVOICE`'s
    unlimited limit; (5) on success, compute `charge_checksum` in SQL
    (`customerBillRepository.computeChargeChecksum` — the spec's resolved
    `md5(subtotal || tax items ordered by category || total_amount)` formula,
    entirely in Postgres, never re-derived in TypeScript) and stamp the bill
    (`stampPosted`: `ref_inv_document_id`/`posted_attempt`/`charge_checksum`/
    `category='normal'`, `IS NULL`-guarded — it returns whether a row was
    actually stamped, and `postAccount` throws when it wasn't so a bill posted
    concurrently between the resume check and the stamp rolls this INV back) +
    mark the account `INVOICED`. **No double-post:** a
    `postDocument` failure throws inside the transaction, so the INV create +
    any partial ledger write roll back together (the non-transactional
    `document_inv_seq` may leave a tolerated gap, Inv. #7); the account is then
    parked by a SEPARATE, non-transactional write (`status` stays `PROCESSED`,
    `errorCode`/`errorDetail` set to the failure) — `PERIOD_CLOSED` and every
    other posting failure are tolerated, resumable per-account errors, never a
    run-level abort. `postRun(billRunId, actorId)` — flips `APPROVED →
    POSTING` once (`billRunRepository.markPosting`, idempotent — a resumed
    call finds the run already `POSTING`), calls `postAccount` for every
    `PROCESSED` account (never `SKIPPED`/`EXCLUDED` — no invoice number
    consumed for them), then, once no account remains `PROCESSED`, completes
    the run straight to `COMPLETED` (`completePosting` stamps `invoiced_at`/
    `completed_at` together in one write — `DISTRIBUTING` is never entered,
    ai-workflow-rules §3.4/code-standards §3, v1 has no distribution targets)
    and writes `BILL_RUN_POSTED` marking the `INVOICED` milestone.
  - Audit: `BILL_RUN_POSTED` added to `AUDIT_EVENT_TYPES` (`types/audit.ts`)
    + `AUDIT_EVENT_CATEGORY_MAP` as `"Additive"` (`types/audit-log.ts`) — new
    INV documents now exist, not merely a status flip (matches
    `BILL_RUN_MATERIALIZED`'s precedent, not `BILL_RUN_APPROVED`'s `"Change"`).
    Ripple: `audit-log-filters.test.tsx` option count 66 → 67.
  - Action: `actions/billing/post-run.action.ts` — `'use server'`, requires
    `billrun_approve:EDIT` (the same money gate as approve), Zod-parses
    `{ billRunId }` (`validation/billing/post-run.schema.ts`), delegates to
    `postRun`, revalidates the run/approve/list pages on success only.
    Re-invocable — Retry-failed is literally the same action call.
  - **No new route.** `/billing/bill-runs/[runId]/approve` (bm10) now branches
    server-side on the live `getApprovePreview` status: `PROCESSED` renders
    the unchanged bm10 `ApproveAndPostPanel`; anything past it renders the new
    `PostingProgressView`. This is the "Reached from the Approve & Post
    confirm (approve → post)" flow the spec's Visual section describes — a
    successful Approve's `router.refresh()` re-renders this same route, which
    now sees `status = 'APPROVED'` and shows posting progress.
  - Read + component: `services/billing/read/get-posting-progress.ts`
    (`getPostingProgress`) — a per-account read joined to `customer_bill` for
    the invoice id, deriving a DISPLAY-ONLY status (`pending` / `invoiced` /
    `PERIOD_CLOSED` / `failed`, never a stored column — same idiom as
    `StallState`) from `bill_run_account.status` + `errorCode`. The read model
    (`PostingAccountStatus`/`PostingProgressRow`/`PostingProgress`) lives in
    `types/billing.ts`, not the service file (components → types/**, never
    services/**, code-standards §2.7/§3 — caught by the boundaries/dependencies
    ESLint rule on first pass). `components/billing/posting-progress-view.tsx`
    (`PostingProgressView`) — the running "{n}/{N} posted" count, a per-account
    status list, and an explicit Post/Retry-failed button. **Never auto-fired
    on page load** — posting is financially consequential (irreversible,
    consumes invoice numbers), so it follows the same explicit-confirm
    discipline as every other operator mutation in this module (resolved
    decision: the spec's "Not a global spinner" note argues against a silent
    background poll, but auto-triggering a real posting call from a mere page
    view — e.g. a back-navigation revisit — would be a dangerous side effect;
    a click is required either way, same as `ApproveAndPostPanel`'s own
    two-step confirm).
  - Wiring: the run detail page's header (`[runId]/page.tsx`) gains a second
    `billrun_approve`-gated link — "Post" while `APPROVED`, "Resume posting"
    while `POSTING` — to the same `/approve` route, alongside bm10's unchanged
    "Approve & Post" link (shown only while `PROCESSED`).
  - Tests: `post-run.service.test.ts` (resume skips a posted bill;
    **[CRITICAL] no double-post** — a `postDocument` failure never stamps the
    bill or marks `INVOICED`, parks via a separate non-tx write instead;
    `PERIOD_CLOSED` parks with the engine's `openPeriodHint` as the detail; an
    unexpected error parks with a generic `POSTING_FAILED` code; charge/tax
    line construction incl. the no-tax-line case; `SKIPPED`/`EXCLUDED`/already-
    `INVOICED` accounts are never iterated; the `APPROVED → POSTING` flip is
    idempotent; the run completes to `COMPLETED` + `BILL_RUN_POSTED` only once
    no account remains `PROCESSED`), `post-run.action.test.ts` (route × level
    matrix), `get-posting-progress.test.ts` (status derivation: `INVOICED` →
    `invoiced` regardless of a stale `errorCode`; `PERIOD_CLOSED`/other codes
    → `PERIOD_CLOSED`/`failed`; no code → `pending`), `approve-page.test.tsx`
    extended (renders `PostingProgressView` once `APPROVED`, `notFound()` if
    posting progress can't be read), `bill-run-detail-page.test.tsx` extended
    (the Post/Resume posting link's show/hide across `APPROVED`/`POSTING`/
    `INVOICED`). `charge_checksum` tamper-detection itself (the SQL `md5` over
    real rows) is a DB-level guarantee — not re-verified by a JS unit test,
    same as bm06's SQL-computed `tax_amount`; a DB-gated integration test is
    **not added in this environment** (no local Postgres reachable, the same
    constraint noted throughout this tracker for every DB-gated suite since
    bm02). `typecheck`/`lint`/`format:check` clean; full DB-free `vitest run`
    (2685 tests) passes except the same pre-existing baseline already on
    `dev1` before this unit — confirmed via `git show HEAD:…` and isolated
    reruns: the 4 hardcoded-date-drift action suites (`create-order`/`resume`/
    `suspend`/`terminate-subscription`), `trigger-run.service.test.ts`'s
    env-var-dependent failure (bm05 session notes), and
    `grep-gates.test.ts`'s inv. #16 BAN-narrowing false positive on
    `db/repositories/billing/bill-run-account.repository.ts` (present at
    `HEAD` before this unit's edits — the bm09 tracker entry already
    documents this exact false positive on this exact file).
    `route-manifest.test.ts`'s one failure under the full parallel run was a
    10s timeout from resource contention, not a real failure — it passes in
    3/3 when run in isolation. bm11 touches none of these files.

- **bm12 — Stall detection & recovery** (`specs/bm12-stall-recovery.md`).
  **No new table.**
  - Stall helper: `services/billing/stall.ts`'s pure, total `isStalled(run,
    now, thresholdMinutes)` — `status = 'PROCESSING'` AND `now() -
    last_progress_at > thresholdMinutes` — never persisted (architecture Inv.
    #10). Threshold is the new `BILLRUN_STALL_THRESHOLD_MINUTES` config
    (`z.coerce.number().int().min(1).default(30)`, `lib/config.ts` +
    `.env.example`), a **global** value per the spec's resolved default #1
    (the plan floats a per-cycle threshold, but there is no cycle column for
    it). `RunDetail` (`types/billing.ts`) and `findDetailById`
    (`bill-run.repository.ts`)/`getRunDetail` gain `lastProgressAt`.
  - Engine client: `services/billing/engine-client.ts`'s `EngineClient`
    interface gains `getExecutionStatus(executionId): Promise<{ state:
    'RUNNING'|'SUCCESS'|'FAILED'|'KILLED' }>` and `killExecution(executionId):
    Promise<void>`. The stub returns synthetic `{ state: 'RUNNING' }`/a no-op
    kill; the real impl's two new endpoint paths (`GET
    /executions/{id}`, `DELETE /executions/{id}/kill`) are **flagged** —
    "verify against the deployed engine version" per the spec's open item —
    since no live Kestra instance exists to confirm the shape against.
  - Check status: `services/billing/reconcile-run.ts`'s `reconcileRun`, one
    row-locked `db.transaction` (`findByIdForUpdate`): `NOT_FOUND` /
    `NO_EXECUTION` (no `workflow_execution_id` recorded) /
    `ENGINE_UNREACHABLE` typed failures; otherwise branches on the engine's
    reported state — `RUNNING` bumps `last_progress_at` only (resets the
    stall clock for a slow-but-alive execution); `FAILED`/`KILLED` pushes the
    run to `PROCESSING_FAILED` (`markProcessingFailed`, the bm04
    `handle-status-push.ts` write reused here); `SUCCESS` re-derives the run
    status from the account grain via the SAME pure `computeRunStatus` every
    stage signal uses (`PROCESSED` if every account is now terminal — repairs
    a lost final stage signal) or, if the account grain disagrees, bumps the
    heartbeat and returns `mismatch: true` rather than forcing a status the
    accounts don't support. Every branch writes one `BILL_RUN_RECONCILED`
    audit row (the spec's optional "if you want the check audited" —
    resolved yes, matching the module's audit-every-operator-mutation
    discipline). Read-only to the ledger; no invoice numbers touched.
  - Cancel run: `services/billing/cancel-run.ts`'s `cancelRun`, one
    `db.transaction`: `findByIdForUpdate` → guard `status = 'PROCESSING'`
    (`STALLED` is the same underlying status, just derived — Design's
    "PROCESSING/STALLED-derived run" resolves to this one check) → best-effort
    `killExecution` (a failed kill is logged via `logger.warn` but does not
    block the cancel — the run row, not the engine, is the operability source
    of truth) → `billRunAccountRepository.resetForCancel` (every scoped
    account EXCEPT `EXCLUDED` → `PENDING`, diagnostics cleared — `EXCLUDED`
    accounts are a deliberate scoping-time decision, never re-entered into the
    pipeline, same drop-`EXCLUDED` convention as bm08's rerun eligibility) →
    `billRunRepository.cancel` (`PROCESSING → CANCELLED`, nulls the three
    workflow-execution-ref columns) → `insertAuditEvent(BILL_RUN_CANCELLED)`.
    Consumes no invoice numbers (nothing posted this early in the lifecycle).
  - Re-trigger extension (the Layer-3 escape, architecture §Design): 
    `services/billing/trigger-run.ts`'s guard now accepts `SCHEDULED`
    (unchanged, date-checked) OR `CANCELLED` (no date check — it was already
    due). Re-triggering from `CANCELLED` computes a NEW attempt
    (`billRunAccountRepository.maxAttemptForRun` + 1), clears the killed
    execution's prior snapshot (`deleteForRun`), then re-scopes via
    `scopeAccounts` and re-snapshots under that new attempt — so the
    re-triggered engine's stage signals can never collide with
    `bill_run_account_stage` history the killed execution left behind
    (architecture Inv. #5 — the idempotency latch is keyed by attempt; a
    collision would otherwise silently no-op-replay a genuine new signal). The
    normal SCHEDULED first-trigger path is byte-identical to before it — no
    extra queries, `attempt` stays the literal `1`, since a never-triggered
    run has no prior snapshot to clash with. The `(cycle, period_start)`
    UNIQUE on `bill_run` prevents a second row — "re-materialize the period
    cleanly" is this same re-trigger of the one run row (spec's resolved
    default #2).
  - Audit: `BILL_RUN_CANCELLED` and `BILL_RUN_RECONCILED` added to
    `AUDIT_EVENT_TYPES` (`types/audit.ts`) + `AUDIT_EVENT_CATEGORY_MAP` as
    `"Change"` (`types/audit-log.ts`) — both are state-transition surfaces,
    not new entities. Ripple: `audit-log-filters.test.tsx` option count 67 →
    69.
  - Actions: `actions/billing/check-status.action.ts` and
    `cancel-run.action.ts`, both `'use server'`, requiring
    `billrun_operate:EDIT` (Zod `{ billRunId }` via the new
    `validation/billing/{check-status,cancel-run}.schema.ts`), delegating to
    the services, revalidating the run page (cancel also revalidates the list
    page — a cancelled run's list-page "Run" affordance changes).
  - Components: `components/billing/stall-banner.tsx` (`StallBanner`, a
    Warning-family banner — "No heartbeat since {formatDatetime(...)}" — with
    a "Check status" primary button and, via `cancel-run-dialog.tsx`
    (`CancelRunDialog`, the `RerunDialog`/`TriggerRunDialog` inline-confirm
    shape), a "Cancel run" secondary trigger opening a spelled-out confirm
    with the destructive-role Confirm inside it — never a bare row action).
    Wired into `[runId]/page.tsx`'s header area (next to `StubDataBanner`),
    gated `canOperate && isStalled(detail, new Date(),
    billRunStallThresholdMinutes)` — same show/hide convention as
    Rerun/Approve/Post: a `billrun_view`-only principal sees the run's normal
    status but no stall affordance. Never a stored `STALLED` pill
    (`RunStatusBadge` is unchanged — 11 members, `STALLED` was never one of
    them).
  - Tests: `stall.test.ts` (just-under/at/over the threshold, every
    non-PROCESSING status never stalled, no-heartbeat-on-PROCESSING is not a
    crash), `cancel-run.service.test.ts` (happy path, not-found/wrong-status
    `NOT_CANCELLABLE`, a failed `killExecution` still cancels-and-logs, no
    execution ref skips the kill call), `reconcile-run.service.test.ts`
    (`NOT_FOUND`/`NO_EXECUTION`/`ENGINE_UNREACHABLE`, RUNNING/FAILED/KILLED/
    SUCCESS-with-all-terminal/SUCCESS-with-a-mismatch, a non-PROCESSING run
    just bumps+audits), `engine-client.test.ts` extended (stub
    getExecutionStatus/killExecution no HTTP; real client's GET/DELETE
    endpoints, non-2xx/network/unrecognized-state → `EngineError`),
    `trigger-run.service.test.ts` extended (re-trigger from CANCELLED bumps
    the attempt and clears-then-re-snapshots; attempt 1 when never
    snapshotted; the SCHEDULED path never touches the two new repo calls),
    the two action route×level tests, `stall-banner.test.tsx` +
    `cancel-run-dialog.test.tsx` (component-level: banner content, Check
    status success/failure/mismatch messaging, Cancel confirm→success/
    failure/dismiss), `bill-run-detail-page.test.tsx` extended (StallBanner
    shown only for an operator on a genuinely stalled run; hidden without the
    permission or without staleness), `config.test.ts` extended
    (`BILLRUN_STALL_THRESHOLD_MINUTES` default/override/below-minimum/
    non-integer). `typecheck`/`lint`/`format:check` clean; the full DB-free
    `vitest run` (2757 tests) passes except the same pre-existing baseline
    already on `dev1` before this unit — confirmed via `git status`: the 4
    hardcoded-date-drift action suites (`create-order`/`resume`/`suspend`/
    `terminate-subscription`, 14 tests) — bm12 touches none of those files.

- **bm13 — End-to-end journey & ship gate** (`specs/bm13-e2e-ship-gate.md`,
  the build plan's final unit, boundary tests/CI). Depends on bm01–bm12 (all
  delivered).
  - **Route × level matrix + code-standards §9 guardrails — audited, all
    already existed.** An `Explore` audit against every §9 item and the
    spec's verification checklist found the three pages' route × level
    matrices (`tests/app/{bill-runs-page,bill-run-detail-page,approve-page}
    .test.tsx`, direct guard-mocked calls, not navigation-only), the two M2M
    handlers' auth/replay/409/charge-rejection matrices (`tests/app/api/
    billrun-{stage-complete,status}.test.ts`, `handle-stage-signal.test.ts`),
    the operate≠approve split and four-eyes (`approve-run.{service,action}
    .test.ts`), partition/idempotency, the state machine, posting/GL
    integrity, and stub isolation all already shipped with the unit that
    introduced each behavior (ai-workflow-rules §4.7 — "land each guardrail
    test with the unit that introduces the behavior"), exactly as designed.
    Nothing here needed rebuilding — only confirming and, where a real gap
    surfaced (below), closing it.
  - **[CRITICAL] Finalization latch was service-layer-only, not DB-enforced —
    closed.** Architecture Inv. #4 and code-standards §6.8 both document the
    `ref_inv_document_id` finalization latch as DB-guarded ("trigger/
    constraint"), but no such trigger existed — only the service layer's own
    guarded writes (`aggregateBill`'s conditional `DELETE … WHERE
    ref_inv_document_id IS NULL`) enforced it. A raw SQL statement bypassing
    the repository layer could still have mutated or deleted a posted bill.
    New forward-only migration `0033_customer_bill_finalization_guard.sql`
    adds `billing.customer_bill_finalization_guard()` + a `BEFORE UPDATE OR
    DELETE` row-level trigger on `billing.customer_bill` (fires on every
    partition automatically — PostgreSQL 11+ row-level triggers on a
    partitioned parent propagate to all partitions, including ones
    `pg_partman` creates later) that raises when `OLD.ref_inv_document_id IS
    NOT NULL`. This is schema DDL, not strictly "tests/CI", but it was the
    only way to make the §9.4 "finalization latch" guardrail actually true
    rather than merely believed true — proven end-to-end by the new E2E
    test's direct `DELETE`/`UPDATE` attempts against a real posted bill,
    both rejected. **Not yet applied** — no local Postgres reachable in this
    environment (the constraint noted for every DB-gated migration since
    bm02); `db:migrate` must run wherever the database lives.
  - **"Claim correctness" / single rating writer — the v1 placeholder,
    landed.** Per the spec's recorded v1 adaptation, this guardrail is
    **inert** (no `rating` table exists yet). `tests/services/billing/
    collect-claim.test.ts` gained two structural assertions: no export
    anywhere in `db/schema` matches `/rating/i`, and `db/repositories/
    billing/rating-claim.ts` (the single sanctioned future writer,
    code-standards §7.1) does not exist. Both fail the moment a `rating`
    table or writer lands without this guardrail being revisited
    (architecture Inv. #2, pending the rating engine).
  - **"No billing-side charge copy" — already fully enforced, no new test
    needed.** Every `db/schema/billing/*` table already carries an exact-
    column-set structural test (`tests/db/*-schema.test.ts`, the bm05
    precedent) that would fail the moment a charge/amount-array column was
    added to any of them — code-standards §9.5's structural half was already
    complete; adding a redundant sweep would only duplicate existing
    coverage.
  - **The one new E2E happy-path journey**
    (`tests/db/billing-e2e-happy-path.integration.test.ts`, DB-gated,
    `describe.skipIf(!DATABASE_URL)`, the `trigger-run.integration.test.ts`/
    `DROP SCHEMA CASCADE` + fresh-migrate pattern). Three billing accounts
    carry the run's three distinct outcomes — BILLED (all six stages driven
    through the actual signed M2M Route Handler, incl. a replay-returns-200
    assertion, then a mid-run rerun of a subset from Taxation), FAILED (a
    HARD aggregation failure via the pass-through M2M path → `PROCESSING_
    FAILED`), EXCLUDED (force-set on the snapshot row after `triggerRun` to
    prove the account's DOWNSTREAM behavior — never billed, `SKIPPED` at
    approval, consumes no invoice number, listed on Uncharged — without
    rebuilding a full order/offering/product-inventory fixture chain just to
    re-earn a partial-period exclusion the Scoping unit's own suites
    already prove; see the test's header comment). The Accounts GL fixture
    stack (system accounts, chart of accounts, GL mappings, the
    `STANDARD_INVOICE` INV reason code) is built by calling the app's own
    production seed functions (`db/seeds/accounts/seed-{sys-accounts,coa,
    gl-mappings,reason-codes}.ts`) directly, not hand-rolled SQL — this is
    the first integration test in the repo to exercise `postDocument`/
    `approveRun`'s live GL resolution against real fixtures. Journey:
    materialize → trigger → M2M stage signals → PROCESSED → review
    (`listAccountBills`/`listUncharged`/`listErrors`) → rerun a subset →
    approve (a **different** four-eyes user) → post → `COMPLETED`, then
    folds in the finalization-latch DB-trigger proof (above) against the
    run's real posted bill, then materializes the next period and asserts it
    is `operable`. **Not run in this environment** — no local Postgres
    reachable (confirmed the file imports cleanly and skips loudly under
    `vitest.integration.config.ts` with `DATABASE_URL` unset).
  - **Route inventory for the M2M surface**
    (`tests/app/api/billrun-route-inventory.test.ts`, DB-free) — closes the
    one enumeration code-standards §5.1 documents in prose ("exactly two
    handlers... no other verbs") but no test previously enforced:
    `app/api/billrun/**` contains exactly the two documented `route.ts`
    files, each declaring `POST` only.
  - **"Next cycle operable at INVOICED, not COMPLETED" (success criterion
    #10) — confirmed as designed, not a gap.** `billRunRepository
    .completePosting` stamps `invoiced_at` and `completed_at` together in
    the same `POSTING → COMPLETED` write (`bill_run.status` never rests at
    the literal `'INVOICED'` value — `DISTRIBUTING` is never entered in v1,
    per bm11). There is therefore no observable window where a run is
    INVOICED but not yet COMPLETED for a test to distinguish; the E2E test's
    final step (materialize the next period, assert it reads `operable`)
    proves what the criterion cashes out to in this release. Recorded here
    per ai-workflow-rules §5.8 so this isn't re-investigated as a bug later.
  - **Permission map / route manifest — confirmed unchanged and accurate.**
    bm13 added no page, permission, or mutation, so code-standards §8's
    table and `tests/app/route-manifest.test.ts`'s frozen `ROUTE_MANIFEST`
    needed no edit; both were read and confirmed to already list exactly the
    three billing pages (the M2M handlers are Route Handlers, not pages, and
    are correctly outside that page-only manifest — now covered instead by
    the new route-inventory test above).
  - **SAST + OWASP ZAP DAST — confirmed present, not modified.** `infra/
    azure-pipelines.yml`'s "Test + SAST" stage (Semgrep, blocks on any
    finding) and `infra/zap-scan-stage.yml` + `infra/zap/{zap-context.xml,
    rules.tsv}` (OWASP ZAP DAST baseline) both already exist and already
    cover the M2M endpoints via the general authz-sweep inventory (code-
    standards §5.7) — no CI file changed. `BILLRUN_APP_TOKEN` was grepped
    end-to-end: it is compared in `lib/service-token.ts` via
    `timingSafeEqual` and never appears in any `logger.*` call.
  - `typecheck`/`lint`/`format:check` clean. The touched/added DB-free files
    (collect-claim.test.ts extended, the new route-inventory test) pass; a
    scoped run of the billing/app/lib DB-free suite (36 files) passes in
    full except the same pre-existing, environment-dependent
    `trigger-run.service.test.ts` failure documented since bm05 (missing
    `DATABASE_URL`/`BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` in this shell) —
    confirmed unrelated; bm13 touches nothing that file imports. The new
    `billing-e2e-happy-path.integration.test.ts` was confirmed to import
    cleanly and skip loudly (not silently) under the integration config with
    `DATABASE_URL` unset; it and migration `0033` must be exercised against
    a real Postgres wherever the database lives before this ship gate can be
    called genuinely green end-to-end.

## Next Up

- **None — the build plan is complete (bm01–bm13).** The one outstanding
  action item is environmental, not a build unit: run `db:migrate` (picks up
  migration `0033`) and `npm run test` (both configs) against a real
  Postgres to execute the DB-gated suites that could only be written and
  statically verified in this environment, most importantly the new bm13 E2E
  journey and the finalization-latch trigger it proves. The Uncharged
  indicative value stays "—" until a rating source exists.

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
- **bm04 resolved decisions** (recorded so they aren't re-litigated, per
  ai-workflow-rules §5.8 — the spec left each of these underspecified):
  - **`POST /api/billrun/[runId]/status` body shape.** The spec states only
    "the workflow's error/`finally` handlers POST a terminal status ... an
    execution-failure marks the run `PROCESSING_FAILED`" without giving the
    field names. Resolved as `{ status: "PROCESSING_FAILED", error_detail?
    }` — a `PROCESSED` push is never accepted here because `PROCESSED` is
    always *derived* by `handleStageSignal`'s run-status recompute once
    every account is terminal (architecture Inv. #12); accepting a pushed
    `PROCESSED` would create a second, competing way to set that status.
    Revisit only if a future unit needs the engine to push a different
    terminal run status.
  - **Which stage flips an account to `PROCESSED`.** bm04 implements only
    six of the nine `Stage` union members this release (scoping already ran
    at bm03's trigger; posting/rendering/distribution are unbuilt). Resolved
    `verification` (the last of the six, matching `Stage` union order in
    `types/billing.ts`) as the terminal stage — a `DONE`/`SKIPPED` signal
    for it moves the account to `PROCESSED`. Revisit when posting/rendering/
    distribution land — the terminal stage moves to `distribution`.
  - **`EXCLUDED` counts as run-recompute-terminal.** The spec's Design §4
    literally lists only `PROCESSED`/`PROCESSING_FAILED` as the "every
    account is terminal" set, but `EXCLUDED` accounts (bm03, scoping-time
    partial-period exclusion) are never signalled downstream — without
    treating `EXCLUDED` as terminal too, a run with any excluded account
    could never reach `PROCESSED`. `compute-run-status.ts` therefore treats
    `{PROCESSED, PROCESSING_FAILED, EXCLUDED}` as the terminal set.
  - **The Validation stage's outcome overrides the caller's signal body.**
    Every other stage is pass-through record-and-advance (the caller's
    `status`/`error_class` are recorded verbatim), but for `stage:
    "validation"` the app computes the outcome itself via
    `validate-account.ts` and that computed outcome — not the request
    body's `status`/`error_class`/`error_code`/`error_detail` — is what gets
    written to the stage row and used to advance the account. This is the
    only way the spec's "the Validation stage's readiness logic is
    implemented" (goal statement) is meaningfully true, since the workflow
    engine has no visibility into billing-profile resolvability.
- **bm05 resolved decisions** (recorded so they aren't re-litigated, per
  ai-workflow-rules §5.8 — the spec left each of these underspecified):
  - **Collection is an app-computed override; Aggregation is a side effect,
    not an override.** The spec's wording differs subtly between the two
    ("the ingest's collection signal records the stage DONE" vs. "invoked
    when the aggregation stage signal arrives"). Resolved: Collection joins
    Validation as a third stage whose *recorded outcome* the app computes
    itself (always `DONE`, discarding the caller's body) — there is nothing
    for a no-op to fail on. Aggregation stays record-and-advance pass-through
    for the stage row itself (whatever the caller signals is what's
    recorded), but a `DONE` signal additionally triggers the `customer_bill`
    write as a side effect. Revisit only if a future spec explicitly wants
    Aggregation's own outcome to be app-computed too.
  - **`tax_total`/`total_amount` in v1.** The spec is silent on what
    Aggregation should write for these beyond "money is `numeric(18,2)`/
    `string`". Resolved: `tax_total = "0.00"` (hardcoded, not computed —
    Taxation is bm06's stage per the Discipline checklist's "no taxation
    logic here"), `total_amount = subtotal` (their sum, trivially, since tax
    is zero). Revisit when bm06 lands — Taxation will overwrite both on the
    same row rather than Aggregation re-deriving them.
  - **The synthetic stub formula.** The spec asks only for "a stable
    function of the `billing_account_id`... e.g. a base amount plus a fixed
    offset derived from the BAN's numeric suffix". Resolved as `100.00 +
    (suffix mod 1000) × 7.50`, computed in integer sen
    (`deriveStubSubtotal`, `services/billing/aggregate-bill.ts`) — an
    arbitrary but stable, non-random, two-decimal-safe choice. Revisit only
    if a demo/UAT need calls for a different stub shape; the *mechanism*
    (pure function of the BAN id, sen arithmetic) is the part that matters,
    not the specific constants.
- **Environment note, not a bm05 defect:** `tests/services/billing/
  trigger-run.service.test.ts` (bm03, untouched by bm05) fails with an
  "Invalid environment configuration" `ZodError` (missing `DATABASE_URL`/
  `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`) whenever this shell's real
  environment doesn't already have those three set — `services/billing/
  trigger-run.ts`'s import graph pulls in `services/billing/business-today.ts`
  → `services/system-config/app-config-read.service.ts` → `lib/config.ts`,
  which eagerly validates the full env schema on module load, and nothing in
  `tests/setup.ts` stubs it. Confirmed this is pre-existing and unrelated to
  bm05 (the file imports nothing bm05 touched): it fails identically with or
  without the bm05 diff applied, and passes cleanly once the three vars are
  exported into the shell before `vitest run`. The full-suite counts reported
  above (244/248, 2512/2526) were taken with those three vars stubbed for
  exactly this reason — running `vitest run` in a shell that hasn't sourced
  a real `.env` will show this file as a 5th failure on top of the 4 known
  date-drift ones.
- **bm08 resolved decisions** (recorded so they aren't re-litigated, per
  ai-workflow-rules §5.8 — the spec left each underspecified):
  - **Re-derivation is gated on the chosen stage.** Spec step 4 says
    "Aggregation/Taxation re-run for the rerun accounts" without stating the
    dependence on `fromStage`. Resolved: since "the new attempt re-runs from the
    chosen stage" (step 3), re-derivation only fires for stages at/after
    `fromStage` — `aggregateBill` when `fromStage <= aggregation`, `taxBill`
    when `fromStage <= taxation` (both via the `STAGES` index). A rerun from
    `verification` re-derives nothing; from `taxation` re-taxes the surviving
    bill (bills are keyed by `(run, ban, period)`, not `attempt`, so they
    persist across attempts); from `aggregation` or earlier rewrites then
    re-taxes. The stub engine does not re-signal in v1, so the service performs
    the re-derivation inline (also what makes the "trial bills re-derive" test
    behavioural without a live engine).
  - **`accountIds` empty ⇒ all eligible; the eligible set excludes `EXCLUDED`
    and posted.** Supports both "all or selected" (goal) call sites: the Errors
    tab passes the failed accounts; the run-level control passes `[]`. An empty
    *resolved* set (e.g. only `EXCLUDED`/posted ids requested) is
    `NO_ACCOUNTS_SELECTED`. Eligibility drops `EXCLUDED` (deliberately not
    billed) and any posted bill (`ref_inv_document_id`, Inv. #4) — belt-and-
    suspenders with `aggregateBill`'s conditional delete.
  - **Empty reason returns `VALIDATION_ERROR`, not the spec's literal
    `VALIDATION_FAILED`.** The action mirrors the sibling `triggerRunAction`'s
    result-code convention (`VALIDATION_ERROR`) for consistency; the spec's §5
    bullet describes the *behaviour* (empty reason rejected), not a binding code
    string. The reason is `z.string().trim().min(1)` — whitespace-only is empty.
  - **Rerun uses one uniform attempt = max(selected `attempt_count`) + 1.**
    `setAttemptForRerun` SETs every selected account to that single value (not a
    per-row `+ 1`), so the per-account `attempt_count`, the audited `attempt`,
    and the engine payload's run-level `attempt` all agree even when a partial
    rerun mixes accounts on divergent attempts. (Superseded the initial
    per-row-increment approach after review.)
  - **The rerun does not update `triggered_by`.** `markRerunProcessing` leaves
    `triggered_by`/`gl_event_at` untouched (Inv. #13 fixes `gl_event_at` at the
    first trigger). Whether a rerun should re-stamp the "final-attempt trigger
    actor" for four-eyes is a bm09 (Approve) concern and out of bm08's scope;
    the DB backstop `approved_by <> triggered_by` still holds against the
    original trigger actor.
  - **Old→new delta display deferred.** The Visual mentions Customers & Bills
    showing old→new totals; with v1's deterministic stub subtotal the
    re-derived total is identical (zero delta), and surfacing the prior total
    would require threading the audit `beforeData` into the read model. bm08
    records the prior total in the `BILL_RUN_RERUN` audit row (the hard
    requirement) and leaves a richer delta column to a later unit once a real
    rating source produces non-trivial deltas.
- **bm12 resolved decisions** (recorded so they aren't re-litigated, per
  ai-workflow-rules §5.8 — the spec left each underspecified beyond its own
  two documented defaults):
  - **Check status IS audited (`BILL_RUN_RECONCILED`).** The spec floats this
    as optional ("if you want the check audited"). Resolved yes — every other
    operator mutation in this module writes exactly one audit row
    (code-standards §1.10), and Check status can itself change the run's
    status (SUCCESS re-derive, FAILED/KILLED push), so treating it as
    unaudited would be the one operator action in the module with no audit
    trail. Category `"Change"`, same as `BILL_RUN_CANCELLED`.
  - **Engine `KILLED` is treated the same as `FAILED` in reconcile.** The spec
    defines the synthetic engine states but doesn't say how Check status
    should treat `KILLED` specifically. Resolved: both push the run to
    `PROCESSING_FAILED` — a `KILLED` execution the app didn't itself kill (no
    local Cancel happened) can no longer progress either way, and
    `PROCESSING_FAILED` is the module's one rerunnable-recovery terminal
    state. Revisit only if a future unit wants `KILLED` to route straight to
    `CANCELLED` instead (would need its own guard, since `cancel()`'s DB write
    is currently keyed off the operator-initiated Cancel path, not a
    reconcile finding).
  - **A `SUCCESS`-but-not-all-terminal reconcile never forces a status.** The
    Design says Check status should "push the run to the correct state (or
    surface the mismatch)" — resolved as: re-derive via the SAME
    `computeRunStatus` every stage signal uses, and ONLY write when it
    actually returns a terminal status; otherwise return `mismatch: true` with
    no write. Forcing `PROCESSED` when the account grain disagrees would
    violate Inv. #12 (status is derived from `bill_run_account`, never
    guessed) and could mark a run `PROCESSED` with accounts still `PENDING`/
    `PROCESSING`.
  - **Re-trigger from `CANCELLED` bumps the attempt sequence; it does not
    reuse attempt 1.** The spec's parenthetical says re-trigger means
    "re-snapshot fresh" without stating the attempt mechanics. Resolved:
    reusing attempt 1 would let the re-triggered engine's stage signals
    collide with `bill_run_account_stage` rows the killed execution already
    wrote at attempt 1 (Inv. #5's idempotency latch would then silently
    "replay" a genuine new signal as a no-op, permanently stalling that
    account under the new execution). `maxAttemptForRun + 1` — the same
    max-then-bump idiom bm08's rerun already established — sidesteps this by
    construction; `deleteForRun` clears the old snapshot rows first so the
    fresh `insertSnapshot` never hits the `(run, ban, period)` UNIQUE either.
  - **`resetForCancel` excludes `EXCLUDED` accounts.** The spec says "reset
    accounts to `PENDING`" without carving out `EXCLUDED`. Resolved: `EXCLUDED`
    is a scoping-time, deliberate non-billing decision (bm03) that nothing
    downstream ever re-enters — bm08's rerun already established the same
    drop-`EXCLUDED` convention for its eligible set. Resetting an `EXCLUDED`
    account to `PENDING` would have the re-triggered engine try to process an
    account Scoping explicitly decided not to bill.
