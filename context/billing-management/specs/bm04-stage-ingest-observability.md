# bm04 — M2M stage ingest + stage-timeline observability — Spec

**Unit:** bm04 (`bm00-build-plan.md`). **Boundary:** M2M Route Handlers (`app/api/billrun/*`) + the `bill-runs` detail read. **Depends on:** bm03 (`bill_run_account`, `PROCESSING`, partman bootstrap); an inbound bearer service token in Key Vault.
**Grounded in** `F:/Projects/enterprise-billing-app/`: `lib/http.ts` (`toHttpResponse`, `STATUS_BY_CODE`), `lib/errors.ts` (`AppError`/`AppErrorCode`), `lib/csrf.ts` (`timingSafeEqual` constant-time compare idiom), `app/api/auth/signin/microsoft/route.ts` (route-handler idiom, `export const dynamic = "force-dynamic"`), `db/bootstrap/audit-partman-setup.*` (partman), `db/client.ts` (`db.transaction`/`tx`), `lib/config.ts`.

---

## Goal

Let the workflow engine (or a signed test caller) drive a `PROCESSING` run's stages through **two session-less M2M endpoints**: each per-account stage signal is recorded **idempotently** in a new partitioned `billing.bill_run_account_stage` table and advances the account, recomputing run status under a row lock until the run reaches `PROCESSED` — surfaced live on the run-detail **Workflow** tab with the HARD/SOFT/INFRA failure taxonomy. The **Validation** stage's readiness logic is implemented; later stages record-and-advance (their real effects land in bm05–07).

---

## Design

### Structural
- **New table `billing.bill_run_account_stage`** — monthly `pg_partman`-partitioned on `period_partition` (bm03 pattern). Columns (plan §6.5): `bill_run_account_stage_id` (`BRS…`), `ref_bill_run_id`, `ref_billing_account_id`, `period_partition` date, `stage` (`Stage` CHECK), `attempt` int, `status` (`StageStatus` CHECK), `started_at`/`ended_at`, `error_class` (`ErrorClass` CHECK, nullable), `error_code`/`error_detail` nullable. **Composite PK `(bill_run_account_stage_id, period_partition)`**; **the idempotency latch = UNIQUE `(ref_bill_run_id, ref_billing_account_id, stage, attempt, period_partition)`**. Register with partman (extend `db/bootstrap/billing-partman-setup.*`).
- **Unions** in `types/billing.ts`: `Stage` = `scoping|validation|collection|aggregation|taxation|verification|posting|rendering|distribution`; `StageStatus` = `PENDING|RUNNING|DONE|FAILED|SKIPPED`; `ErrorClass` = `HARD|SOFT|INFRA`.
- **Two session-less Route Handlers under `app/api/billrun/`** (the platform's first business M2M path; page routes are `/billing/*` but the API namespace stays `/api/billrun/*` per code-standards §7):
  - `POST /api/billrun/[runId]/stage/[stage]/complete` — body `{ ban_id, attempt, status, error_class?, error_code?, error_detail? }`.
  - `POST /api/billrun/[runId]/status` — run-level terminal/execution-failure push.
  Each: `export const dynamic = "force-dynamic"`; **no `getSession`**; bearer-token auth → Zod parse → run-`PROCESSING` guard → service → `Response.json`; errors via `toHttpResponse`.
- **Inbound bearer auth** — `lib/service-token.ts`: `serviceTokenMatches(submitted, expected)` replicating `csrfTokensMatch` (length guard + `timingSafeEqual`), and `requireServiceToken(request)` that reads `Authorization: Bearer <t>`, constant-time-compares against `config.BILLRUN_APP_TOKEN`, and throws `new AppError("UNAUTHENTICATED", …)` on miss. The token is never logged, never string-sliced into logs.
- **Ingest service** `services/billing/handle-stage-signal.ts`, one `db.transaction`:
  1. **Insert the `bill_run_account_stage` row first** — a duplicate `(run, ban, stage, attempt, period_partition)` hits the UNIQUE constraint → caught → **200 no-op replay** (idempotency is the DB constraint, never the orchestrator; architecture Inv. #5).
  2. **Apply the stage's app-side effect** — bm04 implements **Validation** (below); `collection|aggregation|taxation|verification` **record-and-advance** here (their real effects arrive in bm05–07; in v1 stub mode they are pass-through).
  3. **Advance `bill_run_account.status`** — `PENDING → PROCESSING` on the first stage; a `HARD` outcome → `PROCESSING_FAILED` (run continues, account excluded at approval); `SOFT` → stage `DONE` + a finding; `INFRA` → retryable, no terminal change.
  4. **Recompute `bill_run.status` under `SELECT … FOR UPDATE`** on the `bill_run` row (never an incremental counter): when every account is terminal (`PROCESSED`/`PROCESSING_FAILED`) → run `PROCESSED`; bump `last_progress_at`. The optional `ban_count`/`rated_count`/`failed_count` cache may be refreshed here; a test asserts `stored == derived`.
- **`status` push** `services/billing/handle-status-push.ts`: the workflow's error/`finally` handlers POST a terminal status; bumps `last_progress_at`; an execution-failure marks the run `PROCESSING_FAILED` (rerunnable).
- **Guards:** stage signals are **rejected unless the run is `PROCESSING`** — a late/duplicate push after `APPROVED` returns **409**; the `EXCLUDED` accounts (bm03) are never signalled (not in `ban_ids`). HTTPS-only; this path is in the authz-sweep inventory.
- **Validation stage (v1)** `services/billing/validate-account.ts`: a per-account readiness gate — the account has a resolvable billing profile (non-null `currency`, resolvable `bill_cycle` + payment terms). Pass → stage `DONE`, advance. Missing/broken profile → `HARD` (`error_code = 'UNRESOLVABLE_PROFILE'`) → account `PROCESSING_FAILED`. **The claimable-records / zero-charge check is deferred** with the rating engine (no `rating` table in v1).

### Visual (`billmgmt-ui-context.md`)
- **`/billing/bill-runs/[runId]` detail page shell** — Next 16 `params: Promise<{ runId }>` (await it), guard `billrun_view : READ`, parse `runId` against the `BRN` schema (unknown → `notFound()`). Header: cycle, period, `RunStatusBadge`, `StubDataBanner`. **Tabs** via `?tab=` (Workflow default; Customers & Bills / Uncharged / Errors / Audit are placeholder panels filled by bm05–07).
- **Workflow tab** — `StageTimeline` (per-account rows across the stage columns; each cell a `StageStatusBadge`), `ErrorClassBadge` on failures, and the mid-flight summary ("126 processed, 2 `PROCESSING_FAILED`" — per-row progress, **not** a global spinner). Derived counts (never the cache) drive the summary.

---

## Implementation

### 1–3. Schema, migration, partman
`db/schema/billing/bill-run-account-stage.ts` (Drizzle typing only — comment it): columns above, `primaryKey({ columns: [t.billRunAccountStageId, t.periodPartition] })`, the UNIQUE idempotency index, `BRS` id default + `billRunAccountStageSeq`, `Stage`/`StageStatus`/`ErrorClass` CHECKs, FKs to `bill_run`/`billing_account`. Export from `db/schema/index.ts`. Custom SQL migration `db/migrations/NNNN_bill_run_account_stage.sql` (`PARTITION BY RANGE (period_partition)` + default partition + indexes). Extend `db/bootstrap/billing-partman-setup.sql` with a `partman.create_parent(... 'billing.bill_run_account_stage' ...)` registration (monthly, 7-year detach).

### 4. Config — `lib/config.ts`
Add `BILLRUN_APP_TOKEN: z.string().min(32).optional()` (the inbound bearer the engine presents; Key Vault in prod, `.env` locally). Export it; `.env.example` documents it. Absent ⇒ the ingest rejects all calls with 401 (fail-closed) — note this so local/testing sets it.

### 5. Service-token auth — `lib/service-token.ts`
`import "server-only"`. `serviceTokenMatches(a, b)` (length guard + `timingSafeEqual`, mirroring `csrfTokensMatch`). `requireServiceToken(request: Request): void` — extract the `Authorization: Bearer` value, `serviceTokenMatches(value, config.BILLRUN_APP_TOKEN)`; on miss `throw new AppError("UNAUTHENTICATED", "Invalid service token.")`. Never logs the token.

### 6. Validation schemas — `validation/billing/`
`stage-signal.schema.ts` (`{ ban_id: BAN-format, attempt: int≥1, status: StageStatus, error_class?, error_code?, error_detail? }`) and `status-push.schema.ts`. `runId`/`stage` path params parsed against `BRN`-format and the `Stage` enum.

### 7. Route Handlers — `app/api/billrun/[runId]/stage/[stage]/complete/route.ts`, `.../status/route.ts`
```ts
export const dynamic = "force-dynamic";
export async function POST(request: Request, ctx: { params: Promise<{ runId: string; stage: string }> }): Promise<Response> {
  try {
    requireServiceToken(request);                         // 401 on miss
    const { runId, stage } = await ctx.params;            // parse: BRN + Stage enum → 422/404
    const body = stageSignalSchema.parse(await request.json()); // 422
    const result = await handleStageSignal({ runId, stage, ...body }); // 409 if run not PROCESSING
    return Response.json({ data: result }, { status: 200 });
  } catch (err) { return toHttpResponse(err); }
}
```
Envelopes/status per `lib/http.ts`: `200` accepted/replay, `401` bad token, `409` run-not-`PROCESSING`/after-approval, `422` malformed, `500` unexpected. No business logic in the handler.

### 8. Ingest services + Validation
`handle-stage-signal.ts` (the transaction in Design — stage row first, effect, advance account, recompute run under `FOR UPDATE`, heartbeat; a caught unique-violation returns a `replayed: true` result → still 200), `handle-status-push.ts`, `validate-account.ts` (the readiness gate), and a pure `compute-run-status.ts` (account-status set → run status). All framework-agnostic (`Database`/`tx`, no `next/*`). **No `AUDIT_LOG` write per stage signal** — the append-only `bill_run_account_stage` row is the stage audit surface (code-standards §1.10).

### 9. Detail page + Workflow tab — `app/(app)/billing/bill-runs/[runId]/`
`page.tsx` (guard, await params, read `RunDetail` + stage rows via a read service, compose tabs), `loading.tsx`/`error.tsx`. `components/billing/`: `run-detail-tabs.tsx`, `stage-timeline.tsx` (`StageTimeline`), `stage-status-badge.tsx` (`StageStatusBadge`), `error-class-badge.tsx` (`ErrorClassBadge`), and placeholder tab panels for the later units. `export const dynamic = "force-dynamic"` (live status, uncached).

### 10. Tests — `tests/…`
- **Handler auth:** missing/invalid bearer → **401**; token never logged.
- **[CRITICAL] Idempotency:** a valid signal advances `bill_run_account_stage` in one txn; **replay `(run,ban,stage,attempt,period_partition)` → 200 no-op**, no double-advance.
- **Guards:** signal after `APPROVED` → **409**; signal to a non-`PROCESSING` run → **409**; Zod-invalid body → **422**; unknown `runId`/`stage` → **404/422**.
- **Concurrency:** two per-account signals racing → the run flip is atomic under the `FOR UPDATE` row lock (no lost update; counts consistent).
- **Validation:** an unresolvable-profile account → `HARD` → account `PROCESSING_FAILED`, run continues; a healthy account advances.
- **Terminal:** when every account is terminal, the run reaches `PROCESSED`; "PROCESSED with N `PROCESSING_FAILED`" is representable; `ban_count/rated_count/failed_count` cache (if written) `== derived`.
- **Page:** route × level for `/billing/bill-runs/[runId]` (`billrun_view`); unknown run → `notFound`.

---

## Dependencies (packages to install)

**None.** `node:crypto` (`timingSafeEqual`) and `fetch` are native; `zod`/`drizzle-orm`/`postgres` present; pg_partman/pg_cron already provisioned.

---

## Verification checklist

Schema & partitioning
- [ ] Migration creates `billing.bill_run_account_stage` RANGE-partitioned on `period_partition`, composite PK `(…, period_partition)`, **UNIQUE `(ref_bill_run_id, ref_billing_account_id, stage, attempt, period_partition)`**, `Stage`/`StageStatus`/`ErrorClass` CHECKs, FKs, default partition; partman-registered; `db:migrate` + `db:setup-partman-billing` clean.
- [ ] `Stage`/`StageStatus`/`ErrorClass` in `types/billing.ts`; table exported from `db/schema/index.ts`; typecheck/lint/format clean; no new dependency.

M2M ingest (the core)
- [ ] Bad/missing bearer → **401**; the token is never logged; `BILLRUN_APP_TOKEN` absent ⇒ all calls 401 (fail-closed).
- [ ] A valid stage signal inserts the stage row **first** and advances the account in one transaction; **replaying it returns 200 and changes nothing**.
- [ ] A signal after `APPROVED` (or to a non-`PROCESSING` run) → **409**; a malformed body → **422**.
- [ ] Concurrent per-account signals recompute run status atomically under `SELECT … FOR UPDATE`; no lost updates.
- [ ] A `HARD` validation outcome sets the account `PROCESSING_FAILED` and the run keeps going; when all accounts are terminal the run reaches `PROCESSED`.
- [ ] No `AUDIT_LOG` row is written per stage signal (the stage row is the audit surface).

Detail page
- [ ] `/billing/bill-runs/[runId]` renders under `billrun_view` (unknown run → `notFound`); the Workflow tab shows the per-account stage timeline with `StageStatusBadge`/`ErrorClassBadge` and the "N processed, M PROCESSING_FAILED" summary from **derived** counts.
- [ ] The other tabs are inert placeholders (filled in bm05–07); no `customer_bill`/claim logic here.

Discipline
- [ ] Ingest handlers have no `getSession`; services have no `next/*`; docs updated same change set (`billmgmt-code-standards.md` §8 bm04 row + `billmgmt-progress-tracker.md`).
