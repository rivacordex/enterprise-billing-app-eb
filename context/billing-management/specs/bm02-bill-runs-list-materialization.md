# bm02 — Bill Runs list + lazy materialization — Spec

**Unit:** bm02 (`bm00-build-plan.md`). **Boundary:** `billing` schema + the `bill-runs` read path. **Depends on:** bm01 (Billing section, `billrun_view` guard, nav); `billing.bill_cycle` (Accounts — exists, `db/schema/billing/catalogs.ts`).
**Grounded in** `F:/Projects/enterprise-billing-app/` (read-only): `db/schema/billing/{pg-schema,catalogs,accounts}.ts`, `db/repositories/accounts/bill-cycle.repository.ts`, `app/(app)/administration/audit-log/**`, `components/accounts/doc-state-badge.tsx`, `lib/{config,formatters}.ts`, `db/migrations/0012_billing_module_tables.sql`.

> **Materialization scope:** on each page load, only the **single most-recent due period** (the just-closed month — 1 month back) is created per active cycle. **No multi-month backfill** — a cycle-month whose page was never opened is not retro-created; any earlier `SCHEDULED` run already materialized simply stays operable.

---

## Goal

On opening **Billing → Bill Runs**, lazily materialize each active `bill_cycle`'s due monthly-in-arrears run(s) into a new `billing.bill_run` table — idempotently under concurrent loads (`ON CONFLICT (ref_bill_cycle_id, period_start) DO NOTHING`) — and render a two-tab (**Current & Upcoming** / **Historical**), filterable, CSV-exportable list where each run shows its `RunStatusBadge`, with a persistent stub-data banner while the environment stub flag is set.

---

## Design

### Structural
- **New table `billing.bill_run`** (run header, low volume, **not partitioned**) with a `bill_run_seq` → `BRN` id. It is the single header row per run; per the codebase's bulk-table convention (migration `0012`) and to avoid churny `ALTER`s across later units, **bm02 creates the full header column set from plan §6.1**, but only the materialize subset is populated here (a deliberate, documented exception to strict just-in-time for a stable header table). Later units write `workflow_execution_id`, `gl_event_at`, `total_amount`, `approved_by`, the later timeline stamps, etc.
- **Materialization is a write on the list page's server render** (RSC), not an action/route/job (architecture Inv. #10). It computes the **single most-recent due period** per active cycle (the just-closed month — 1 month back) and inserts it if missing, idempotently, in one transaction — **no multi-month backfill**; a `BILL_RUN_MATERIALIZED` audit row is written **only** for a row actually inserted (no-op loads write nothing).
- **Window derivation (monthly in-arrears, `cycle_day` 1–28):** for `cycle_day = d`, `period_start` = the d-th of month *M*; `period_end` = (d-th of *M+1*) − 1 day; `scheduled_run_date` = `period_end + 1`. A period is **due** (materializable) when `scheduled_run_date <= today` (business "today" in the app timezone). `frequency` is `monthly` in v1; non-monthly cycles are skipped with a logged note (multi-frequency is out of scope, overview *Out of scope*).
- **Operability:** per cycle, the **one operable run** is the oldest run with `status < APPROVED` whose `scheduled_run_date <= today` (past-due first, oldest-first). Upcoming runs (`scheduled_run_date > today`) render **disabled** with a "period closes {date}" reason. bm02 renders operability state; the Run action itself is bm03.
- **Two tabs via a `?tab=current|historical` searchParam** (no `Tabs` component exists — reuse the audit-log URL-searchParam idiom): **Current & Upcoming** (operable + upcoming, grouped by cycle) and **Historical** (terminal runs — `COMPLETED`/`CANCELLED` — read-only, filter by cycle + status, paginated, CSV export). A `PROCESSING_FAILED`/`DISTRIBUTION_FAILED` run is operable-again and stays in Current.
- **CSV export** (Historical) is a **server action** returning CSV text, with a small client control that triggers a `Blob` download — **not** a Route Handler (general code-standards §5 reserves handlers for auth/M2M). Built from scratch (no CSV in the codebase).

### Visual (tokens from `billmgmt-ui-context.md`)
- **`RunStatusBadge`** — a `cva` component (pattern: `components/accounts/doc-state-badge.tsx`) mapping the 11 `RunStatus` values to the families in `billmgmt-ui-context.md` §1 (e.g. `PROCESSING`→info, `PROCESSED`→warning, `APPROVED`→brand, `INVOICED`/`COMPLETED`→success, `*_FAILED`→danger, `SCHEDULED`/`CANCELLED`→neutral), each with a `lucide-react` icon + label.
- **`StubDataBanner` / `StubBadge`** — persistent warning-family banner on the list while `STUB_DATA_MODE` is on (`billmgmt-ui-context.md` §6), plus a list-row chip.
- Reuse the audit-log **table / pagination / filter** primitives; the operable run renders as a `RunActionCard`. Empty states: no cycles → link to Accounts Settings; no runs yet → explain; Historical empty is a normal state.
- Period columns are **calendar dates** (`YYYY-MM-DD`, no timezone) rendered as `dd Mon yyyy`; monetary/`total_amount` is not shown in bm02 (derived later).

---

## Implementation

### 1. Schema — `db/schema/billing/bill-run.ts`
Follow the `billing` pgSchema idiom (`import { billing } from "@/db/schema/billing/pg-schema"`). Define:
```ts
export const billRunSeq = billing.sequence("bill_run_seq", { startWith: 1 });

export const billRun = billing.table("bill_run", {
  billRunId: text("bill_run_id").primaryKey()
    .default(sql`'BRN' || lpad(nextval('billing.bill_run_seq')::text, 8, '0')`),
  refBillCycleId: text("ref_bill_cycle_id").notNull()
    .references(() => billCycle.billCycleId, { onDelete: "restrict" }),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  scheduledRunDate: date("scheduled_run_date", { mode: "string" }).notNull(),
  status: text("status").notNull().default("SCHEDULED"),
  runType: text("run_type").notNull().default("onCycle"),
  // --- populated by later units (nullable now) ---
  workflowExecutionId: text("workflow_execution_id"),
  workflowDefinitionId: text("workflow_definition_id"),
  workflowDefinitionRevision: integer("workflow_definition_revision"),
  lastProgressAt: timestamp("last_progress_at", { withTimezone: true, precision: 3, mode: "date" }),
  glEventAt: date("gl_event_at", { mode: "string" }),
  refTaxRateVersion: text("ref_tax_rate_version"),
  banCount: integer("ban_count"), ratedCount: integer("rated_count"), failedCount: integer("failed_count"),
  totalAmount: numeric("total_amount", { mode: "string", precision: 18, scale: 2 }),
  triggeredBy: text("triggered_by").references(() => appuser.id, { onDelete: "restrict" }),
  approvedBy: text("approved_by").references(() => appuser.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 3, mode: "date" }).notNull().default(sql`now()`),
  processedAt: timestamp(/* … */), approvedAt: /* … */, postingStartedAt: /* … */,
  invoicedAt: /* … */, distributingAt: /* … */, completedAt: /* … */,
}, (t) => [
  unique("bill_run_cycle_period_unique").on(t.refBillCycleId, t.periodStart),
  check("bill_run_status_check", sql`status IN ('SCHEDULED','PROCESSING','PROCESSED','APPROVED','POSTING','INVOICED','DISTRIBUTING','COMPLETED','PROCESSING_FAILED','DISTRIBUTION_FAILED','CANCELLED')`),
  check("bill_run_run_type_check", sql`run_type IN ('onCycle','offCycle')`),
  check("bill_run_approver_distinct_check", sql`approved_by IS NULL OR approved_by <> triggered_by`),
]);
export type BillRun = typeof billRun.$inferSelect;
export type BillRunInsert = typeof billRun.$inferInsert;
```
Export it from `db/schema/index.ts` so the Drizzle client sees it, then generate the migration with `npm run db:generate` (drizzle-kit) and review the produced `db/migrations/NNNN_*.sql` (creates the sequence + table + unique + checks). Do **not** hand-write the DDL.

### 2. Config flag — `lib/config.ts`
Add, using the existing `booleanEnvSchema` helper: `STUB_DATA_MODE: booleanEnvSchema("false")`. Add `STUB_DATA_MODE=true` to `.env.example` (documented). Expose a frozen accessor `export const stubDataMode = config.STUB_DATA_MODE;` (or read `config.STUB_DATA_MODE` in the page and thread it to the banner as a prop — never read env in a client component).

### 3. Types — `types/billing.ts`
`as const` unions (code-standards §2): `RunStatus` (the 11 values), `RunType` (`'onCycle' | 'offCycle'`), and the read model `RunListRow` (`billRunId`, `cycleId`, `cycleName`, `periodStart`, `periodEnd`, `scheduledRunDate`, `status`, `runType`, `operable: boolean`, `pastDue: boolean`). Composed in `types/`, returned by the service — the page never re-derives operability.

### 4. Window derivation + materialization
- **Pure helper** `services/billing/derive-periods.ts` — `currentDuePeriod(cycleDay, today): { periodStart, periodEnd, scheduledRunDate } | null` returning the **single most-recent** in-arrears period whose `scheduled_run_date <= today` (the just-closed month), or `null` if none is due yet. Total, never-throwing, timezone-safe (calendar math via the shared `lib/timezone.ts` boundary helper; "today" resolved server-side from `getAppTimezone()`). Unit-tested for `cycle_day` 1 / 15 / 28, none-due-yet, and month/year boundaries.
- **No backfill, no lookback config.** Exactly one period (the most-recent due) is considered per cycle per load; older un-opened months are never retro-materialized. An earlier `SCHEDULED` run already in the table stays operable oldest-first (Design §Operability).
- **Repository** `db/repositories/billing/bill-run.repository.ts`: `insertMissingRuns(tx, rows)` → `INSERT … ON CONFLICT ON CONSTRAINT bill_run_cycle_period_unique DO NOTHING RETURNING bill_run_id` (returns only actually-inserted rows, for the audit); `listRuns(db, { tab, cycleId?, status?, page })`; finders.
- **Service** `services/billing/materialize-runs.ts`: read active cycles (`billCycleRepository.findAllActive`), for each monthly cycle compute the **current due period** (`currentDuePeriod`, skip if `null`), `insertMissingRuns` (one row per cycle), and write one `BILL_RUN_MATERIALIZED` audit event per inserted run — all in **one transaction**. Idempotent and concurrency-safe (the unique constraint + `ON CONFLICT`).
- **Read service** `services/billing/read/list-runs.ts`: returns `RunListRow[]` + pagination, tab/cycle/status-filtered; resolves the single operable run per cycle (oldest `status < APPROVED`, `scheduled_run_date <= today`).

### 5. Page — `app/(app)/billing/bill-runs/page.tsx`
Replace bm01's static empty state. Order: `await requirePermission(PERMISSIONS.BILLRUN_VIEW, LEVELS.READ)` → parse `searchParams` (`tab`/`cycle`/`status`/`page`) with a `validation/billing/bill-runs-list.schema.ts` Zod schema (`.catch()` defaults: `tab=current`, page 1) → **`await materializeDueRuns()`** (write) → `await listRuns(parsed)` (read) → render. Thread `timezone`/`stubDataMode` as props. Keep the empty-state component for the "no runs" case. `loading.tsx`/`error.tsx` from bm01 stay.

### 6. Components — `components/billing/`
`bill-run-list.tsx` (`BillRunList` — tabs + grouped Current/Upcoming + Historical table), `run-action-card.tsx` (`RunActionCard` — operable run surface; the Run button is inert/bm03), `run-status-badge.tsx` (`RunStatusBadge`), `bill-runs-filters.tsx` + `bill-runs-pagination.tsx` (audit-log pattern; may generalize the audit-log pagination component — extend, never fork), `stub-data-banner.tsx` (`StubDataBanner` + `StubBadge`), `export-runs-button.tsx` (client control calling the CSV server action → `Blob` download). Tab switch is a `<Link href="?tab=…">`.

### 7. CSV export — `actions/billing/export-runs.action.ts`
`'use server'` action: `requirePermission(billrun_view, READ)` → `listRuns` (no pagination, filtered by the current tab/cycle/status) → build a CSV string (header + rows: run id, cycle, period, scheduled date, status, run type) → return `{ filename, csv }`. `ExportRunsButton` creates a `Blob` and triggers download. A `GET` export is **not** audited (read-only).

### 8. Tests — `tests/…`
Route × level matrix for `/billing/bill-runs` (view granted → renders; no grant → `/no-access`); **materialize idempotency** (two concurrent renders → exactly one row per period, via the unique constraint); `currentDuePeriod` unit tests (cycle_day 1/15/28, in-arrears window, none-due-yet, year boundary); operable-run selection (oldest past-due `< APPROVED`, upcoming disabled); `RunStatusBadge` renders all 11 states; tab/filter/pagination; CSV contains the filtered rows; `StubDataBanner` shows iff `STUB_DATA_MODE`.

---

## Dependencies (packages to install)

**None.** Uses installed `drizzle-orm`, `zod`, `lucide-react`, `class-variance-authority`. CSV is hand-rolled (no library — a small header+rows join; avoids a dependency for a trivial format). The `date` column helper and `booleanEnvSchema` are existing.

---

## Verification checklist

Schema & build
- [ ] `npm run db:generate` produces a migration creating `billing.bill_run_seq` + `billing.bill_run` with the unique `(ref_bill_cycle_id, period_start)`, the status/run_type/approver CHECKs, and the `BRN` id default; `npm run db:migrate` applies clean.
- [ ] `npm run typecheck`/`lint`/`format:check` clean; `bill_run` exported from `db/schema/index.ts`; `RunStatus`/`RunType`/`RunListRow` in `types/billing.ts`.
- [ ] No new dependency added.

Materialization (the core behavior)
- [ ] Opening the page on/after a period's `scheduled_run_date` creates that period's `SCHEDULED` run per active monthly cycle **exactly once**, proven under concurrent loads (unique constraint + `ON CONFLICT DO NOTHING`).
- [ ] Window derivation is correct for `cycle_day` 1, 15, 28 and across month/year boundaries; `scheduled_run_date = period_end + 1`; in-arrears.
- [ ] Only the **single most-recent due period** is created per cycle per load; older un-opened months are **not** retro-created; an already-materialized earlier `SCHEDULED` run stays operable oldest-first.
- [ ] Non-monthly cycles are skipped (no run created), logged.
- [ ] A `BILL_RUN_MATERIALIZED` audit row is written **only** for rows actually inserted; a no-op load writes zero audit rows.

List & UI
- [ ] Current & Upcoming shows one operable run per cycle (oldest `< APPROVED`, past-due first) and upcoming runs disabled with a reason; `*_FAILED` runs stay operable in Current.
- [ ] Historical lists terminal runs read-only, filterable by cycle + status, paginated; empty Historical is a normal state, not an error.
- [ ] `RunStatusBadge` maps all 11 statuses to the ui-context families; tabs switch via `?tab=`; deep links pass the `billrun_view` guard.
- [ ] CSV export downloads the currently-filtered rows; the export action re-checks `billrun_view`.
- [ ] `StubDataBanner` is visible on every load while `STUB_DATA_MODE=true`, hidden when false.

Scaffold discipline
- [ ] No `bill_run_account` or any other billing table is created (that is bm03); no trigger/engine code; the Run button is inert.
- [ ] Docs updated in the same change set: the bm02 row/notes in `billmgmt-code-standards.md` §8 and `billmgmt-progress-tracker.md`.
