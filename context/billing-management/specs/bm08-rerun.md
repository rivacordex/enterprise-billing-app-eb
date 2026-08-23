# bm08 — Rerun (full & partial) — Spec

**Unit:** bm08 (`bm00-build-plan.md`). **Boundary:** `bill-runs` operate path. **Depends on:** bm04–bm07 (a complete draft pipeline to re-derive), bm03 (engine client, `attempt`).
**Grounded in** `F:/Projects/enterprise-billing-app/`: the action→dialog→service(txn)→`insertAuditEvent`→`revalidatePath` template (bm03), the ingest/attempt model (bm04), the aggregation/taxation re-derivation guards (bm05/bm06).

---

## Goal

While a run is `PROCESSED` and **not yet approved**, RevOps reruns **all or selected** accounts from a chosen stage with a **mandatory reason** — the audit event is written **before** re-trigger, every rerun account's `attempt_count` is set to **one uniform new attempt** (the maximum existing `attempt_count` among the selected accounts, plus one — so accounts previously on a lower value advance by more than one, keeping the whole rerun set on a single attempt number for the engine and the attempt-keyed stage latch), their later-stage outputs are invalidated and their trial bills re-derived, and **nothing carrying `ref_inv_document_id` is ever touched**.

---

## Design

### Structural
- **Precondition:** run `status = 'PROCESSED'` (rerun is pre-approval only; a `PROCESSING_FAILED` run is also rerunnable). Reject on `APPROVED`+ (409/typed result).
- **Rerun service** `services/billing/rerun-run.ts`, one `db.transaction`:
  1. **Audit first** — `insertAuditEvent(tx, { eventType: 'BILL_RUN_RERUN', targetId: runId, beforeData: { priorTotals }, afterData: { accounts, fromStage, reason } })` **before** any re-trigger (architecture Inv.; overview).
  2. **Uniform new `attempt_count`** for the selected `bill_run_account` rows — all set to `max(selected attempt_count) + 1` (not an independent per-row `+= 1`, so a lower-valued account may advance by more than one); set them `PROCESSING`; run → `PROCESSED → PROCESSING`.
  3. **Invalidate later stages** — the new attempt re-runs from the chosen stage; because `bill_run_account_stage` is keyed by `attempt`, new-attempt signals create fresh rows from `fromStage` onward and never collide with the prior attempt (idempotency latch includes `attempt`). Prior-attempt rows remain as history.
  4. **Re-derive trial bills** — Aggregation/Taxation re-run for the rerun accounts via the **conditional `DELETE … WHERE ref_inv_document_id IS NULL` + INSERT** (bm05/bm06); a bill carrying `ref_inv_document_id` is never deleted (in bm08 none are posted yet — the guard is proven here and enforced for real in bm11).
  5. **Claim release/re-claim** — v1 **no-op** (no `rating` table); a marker documents where release-then-re-claim lands with the rating engine.
  6. **Re-trigger** the engine (stub) scoped to `ban_ids` = the rerun accounts, with the new `attempt`.
- **Finalization guard is absolute:** the service refuses to invalidate or re-derive any row with `ref_inv_document_id` set (belt-and-suspenders with the DB delete guard).
- **Rerun loop:** `PROCESSED → PROCESSING → PROCESSED`; the run returns to `PROCESSED` when the rerun accounts are terminal again.

### Visual (`billmgmt-ui-context.md`)
- **`RerunDialog`** — from the Errors tab ("Rerun these accounts") or a run-level "Rerun" control: a preview ("Rerun {N} accounts from stage {X}; later stages recomputed"), a **mandatory reason** field, confirm. After success, the selected accounts visibly drop to `PROCESSING`, the timeline greys the invalidated later stages, and Customers & Bills shows **old → new total deltas** so the operator can confirm the fix landed.
- Stage selector offers Validation → Verification (the re-derivable stages).

---

## Implementation

### 1. Rerun service — `services/billing/rerun-run.ts`
The transaction above, returning a typed `Result` (`ok` | `NOT_RERUNNABLE` | `NO_ACCOUNTS_SELECTED` | `ENGINE_UNREACHABLE`). Engine call inside the txn (bm03 pattern — rollback on failure).

### 2. Action + validation — `actions/billing/rerun-run.action.ts`, `validation/billing/rerun-run.schema.ts`
`'use server'`: `requirePermission(PERMISSIONS.BILLRUN_OPERATE, LEVELS.EDIT)` → parse `{ billRunId, accountIds[], fromStage, reason: non-empty }` → `rerunRun` → `revalidatePath` the run pages.

### 3. Audit event — `types/audit.ts` / `types/audit-log.ts` / test
Add `BILL_RUN_RERUN` (category `"Change"`) + the map entry + the coverage test.

### 4. Components — `components/billing/rerun-dialog.tsx`
`RerunDialog` (preview + reason + submitting/error), `router.refresh()` on success; wired to the Errors tab and a run-level control.

### 5. Tests — `tests/…`
- **[CRITICAL] Audit before re-trigger** — the `BILL_RUN_RERUN` row (with prior totals + reason) is committed before the engine is called (ordering asserted).
- **[CRITICAL] Scoped invalidation** — rerunning stage N for selected accounts creates fresh new-attempt stage rows from N onward for **only** those accounts; other accounts and stages < N are untouched.
- **[CRITICAL] Finalization guard** — a bill/row carrying `ref_inv_document_id` is never invalidated or deleted (asserted structurally + behaviorally).
- `attempt_count` increments per rerun; the run loops `PROCESSED → PROCESSING → PROCESSED`.
- Trial bills (+ tax) re-derive for the rerun accounts; deltas surface in the read model.
- Reason is mandatory (empty → `VALIDATION_ERROR`, matching the sibling `triggerRunAction` result-code convention); `billrun_operate` required (a `billrun_view` user → `FORBIDDEN`).
- Rerun on an `APPROVED`+ run is rejected.

---

## Dependencies (packages to install)

**None.** Reuses the engine client, aggregation/taxation services, `insertAuditEvent`, `zod`.

---

## Verification checklist

- [ ] Typecheck/lint/format clean; `BILL_RUN_RERUN` added to `AUDIT_EVENT_TYPES` + `AUDIT_EVENT_CATEGORY_MAP` (+ coverage test); no new dependency.
- [ ] Rerun writes its audit row (actor, accounts, prior totals, reason) **before** re-trigger; only on a `PROCESSED`/`*_FAILED` run.
- [ ] Selected accounts all get the same new `attempt_count` = `max(selected attempt_count) + 1` (lower-valued accounts may jump by more than one), drop to `PROCESSING`, and re-run from the chosen stage; invalidation is scoped to those accounts and stages `> fromStage`; the run loops back to `PROCESSED`.
- [ ] Trial `customer_bill` (+ tax) re-derive under the `ref_inv_document_id IS NULL` guard; **nothing with `ref_inv_document_id` is touched**.
- [ ] Claim release/re-claim is a documented v1 no-op (no `rating` table).
- [ ] `billrun_operate` enforced; mandatory reason; `RerunDialog` shows the preview + old→new deltas.
- [ ] Docs updated same change set (`billmgmt-code-standards.md` §8 bm08 row + `billmgmt-progress-tracker.md`).
