# bm07 — Verification, Uncharged & Errors (+ Audit) tabs — Spec

**Unit:** bm07 (`bm00-build-plan.md`). **Boundary:** `billing` services + detail read. **Depends on:** bm04 (stage ingest, detail tabs), bm03 (`EXCLUDED` accounts), bm05/bm06 (bills).
**Grounded in** (repo-relative): `components/audit-log/*` + the audit read (`getAuditLog`), `bill_run_account`/`bill_run_account_stage` (bm03/bm04), the bm02 CSV-export server-action pattern, the accounts deep-link idiom.

> **No new table.** Uncharged reads `bill_run_account` rows with `status = 'EXCLUDED'`; Errors reads `PROCESSING_FAILED` accounts + their `HARD` stage rows; Audit reuses the existing `AUDIT_LOG` read filtered to the run. **Verification (v1) is minimal** — with synthetic stub figures and no prior-period baseline, plausibility/variance checks are deferred; the stage records `DONE` and writes `SOFT` findings only where a cheap check applies.
> **Note (indicative value):** the Uncharged tab's "indicative value" has **no source in v1** (no rating) — shown as "—/not available"; the uncharged window (the run period) and reason are shown. Confirm if you'd rather derive a synthetic indicative value.

---

## Goal

The **Verification** stage records per-account findings, and the run-detail **Uncharged**, **Errors**, and **Audit** tabs surface — respectively — the accounts deliberately not billed (`EXCLUDED` partial-period), the blocking `HARD` failures (fix-then-rerun), and the run's audit trail; Uncharged is CSV-exportable and deep-links to Accounts → Transactions. No new table.

---

## Design

### Structural
- **Verification stage (stage — `verification` signal)** `services/billing/verify.ts`: v1 records the stage `DONE` per account; a cheap check (e.g. `total_amount <= 0` — shouldn't happen with stub figures, but a backstop) raises a `SOFT` finding recorded as a `bill_run_account_stage` row (`error_class = 'SOFT'`, `error_code`). **No new findings table** — findings are `SOFT` stage rows; exclusions are `EXCLUDED` account rows. Real variance/plausibility checks arrive with real charges.
- **Uncharged read** `services/billing/read/list-uncharged.ts`: `bill_run_account` where `status = 'EXCLUDED'`, joined to the account (name/BAN) + reason (`error_code = 'PARTIAL_PERIOD'`); returns the uncharged window (run period) and indicative value (`null` in v1).
- **Errors read** `services/billing/read/list-errors.ts`: `bill_run_account` where `status = 'PROCESSING_FAILED'`, joined to its latest-attempt `HARD` `bill_run_account_stage` row (`error_code`/`error_detail`/`stage`).
- **Audit read**: reuse the platform `getAuditLog`-style read, filtered to `target_id = runId` (and the run's account events) — the run's `BILL_RUN_*` events (materialize/trigger/rerun/approve/cancel land across units).

### Visual (`billmgmt-ui-context.md` §5/§7)
- **Uncharged tab** (`UnchargedTable`) — **info/neutral** "revenue queue" treatment; per row: account, reason, uncharged window, indicative value ("—" in v1), a **deep link** to Accounts → Transactions ("Recover via a manual DBN/ADJ"). CSV export (bm02 server-action + Blob pattern). Zero exceptions is a positive empty state.
- **Errors tab** (`ErrorsTable`) — **destructive** "blocking" treatment; per row: account, `ErrorClassBadge` (HARD), `error_code` + detail, and a "Rerun these accounts" affordance (the rerun action lands in bm08).
- **Audit tab** (`AuditTable`) — reuse the audit-log table component; the run's events, newest first.
- All three fill the bm04 placeholder panels.

---

## Implementation

### 1. Verification service — `services/billing/verify.ts`
`verifyAccount(tx, run, banId)` — record `verification` `DONE`; on a failed backstop check, write a `SOFT` stage row. Invoked via the bm04 ingest `verification` signal. Framework-agnostic.

### 2. Read services — `services/billing/read/{list-uncharged,list-errors,list-run-audit}.ts`
Return `UnchargedRow[]` / `ErrorRow[]` / audit rows (composed read models in `types/billing.ts`). No writes.

### 3. Components — `components/billing/{uncharged-table,errors-table,audit-table}.tsx` + CSV
`UnchargedTable`, `ErrorsTable`, `AuditTable`; `export-uncharged.action.ts` (`'use server'`, `requirePermission(billrun_view)`, returns CSV; `ExportUnchargedButton` triggers the Blob download). Wire the three tabs into `run-detail-tabs.tsx`.

### 4. Tests — `tests/…`
- Uncharged lists exactly the `EXCLUDED` accounts with reason + window; CSV contains them; the deep link carries the account context.
- Errors lists exactly the `PROCESSING_FAILED` accounts with their HARD code/detail; zero errors is a positive empty state.
- Verification records `DONE` and a `SOFT` finding only on the backstop check; never blocks the run.
- Audit tab shows the run's events (target = run); route × level for all three tabs (`billrun_view`).

---

## Dependencies (packages to install)

**None.** Reuses the audit-log components, the CSV server-action pattern, `drizzle-orm`/`zod`.

---

## Verification checklist

- [ ] No new table; typecheck/lint/format clean; no new dependency.
- [ ] **Uncharged** = exactly the `EXCLUDED` accounts (reason `PARTIAL_PERIOD`, uncharged window shown, indicative value "—"); CSV-exportable; deep-links to Accounts → Transactions.
- [ ] **Errors** = exactly the `PROCESSING_FAILED` accounts with `ErrorClassBadge` + code/detail; a "rerun these" affordance (action in bm08); zero-errors empty state is positive.
- [ ] **Verification** records `DONE` per account and a `SOFT` finding only on the backstop; it never fails/blocks the run.
- [ ] **Audit** tab shows the run's `AUDIT_LOG` events (target = run), newest first.
- [ ] Route × level (`billrun_view`) for the three tabs; docs updated same change set (`billmgmt-code-standards.md` §8 bm07 row + `billmgmt-progress-tracker.md`); the indicative-value "—" default recorded.
