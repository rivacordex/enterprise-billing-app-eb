# bm10 — Approve (four-eyes gate) — Spec

**Unit:** bm10 (`bm00-build-plan.md`). **Boundary:** `bill-runs` approve path. **Depends on:** bm09 (GL mappings + period state for the checks), bm05–bm07 (bills, terminal accounts).
**Grounded in** `F:/Projects/enterprise-billing-app/`: the action→dialog→service(txn)→`insertAuditEvent`→`revalidatePath` template (`services/accounts/close-billing-account.ts`), `accounting-period.repository.findByPeriodAndCurrency`, the `gl_resolution_view`/GL-resolution read (bm09), `bill_run.approver_distinct` CHECK (bm02), `types/audit.ts`.

---

## Goal

A **different** approver (≠ the final trigger actor) opens **Approve & Post**, sees the pre-approval checklist (accounting period open, GL mappings resolvable, no zero/negative totals, approver ≠ trigger actor, all accounts terminal), and approves — stamping `approved_by`/`approved_at`/the immutable `total_amount` and moving the run `PROCESSED → APPROVED`; failed/excluded accounts are recorded `SKIPPED`. (Posting itself is bm11.)

---

## Design

### Structural
- **Precondition:** run `status = 'PROCESSED'`, every account terminal (`PROCESSED`/`PROCESSING_FAILED`/`EXCLUDED`).
- **Four-eyes (segregation of duties):** the approver ≠ the user who triggered the **final** attempt (`bill_run.triggered_by`) — enforced in the **service layer** (typed `FOUR_EYES_VIOLATION`) and backed by the `bill_run.approver_distinct` DB CHECK (bm02). The UI additionally disables Approve for the trigger actor with a reason (show/hide only).
- **Pre-approval checks** (all must pass; each renders pass/fail + remediation), `services/billing/pre-approval-checks.ts`:
  1. **Accounting period open** — `accountingPeriodRepository.findByPeriodAndCurrency(periodKeyFor(gl_event_at), currency)` is not `closed` (an absent row = open).
  2. **GL mappings resolvable** — the INV revenue + tax mappings resolve (bm09's `gl_resolution`); an unresolved mapping blocks.
  3. **No zero/negative totals** — a backstop (zero-charge accounts were excluded at Scoping; with synthetic stub figures totals are positive); any `total_amount <= 0` among postable bills blocks.
  4. **Approver ≠ trigger actor** (four-eyes).
  5. **All accounts terminal.**
- **Approve service** `services/billing/approve-run.ts`, one `db.transaction`: `SELECT … FOR UPDATE` the run → guard `PROCESSED` → run all pre-approval checks (fail → typed result, no state change) → stamp `approved_by`, `approved_at`, immutable `total_amount` (SQL sum of the **postable** bills, i.e. non-`SKIPPED`) → mark `PROCESSING_FAILED`/`EXCLUDED` accounts `SKIPPED` → run → `APPROVED` → `insertAuditEvent(BILL_RUN_APPROVED)`.
- Posting (`APPROVED → POSTING → INVOICED`) is **bm11**; bm10 stops at `APPROVED`.

### Visual (`billmgmt-ui-context.md` §7)
- **`/billing/bill-runs/[runId]/approve`** — `ApproveAndPostPage` (guard `billrun_approve : EDIT`, await params). `ApproveAndPostPanel` names the **final trigger actor** ("Final trigger by {user} at {time}"), **pre-empts self-approval** (Approve disabled for that actor + reason, backed by the service check), **frames irreversibility** ("Post {N} invoices totalling {amount}. This consumes invoice numbers and cannot be undone; corrections require a manual credit note.") with an explicit confirm, and **shows the excluded/skipped count**. `PreApprovalChecks` renders each check pass/fail with a remediation line. The confirm action uses the **danger role** inside the dialog.

---

## Implementation

### 1. Pre-approval checks + approve service
`services/billing/pre-approval-checks.ts` (pure-ish reads returning a `{ check, pass, remediation }[]`), `services/billing/approve-run.ts` (the transaction; returns `ok` | `NOT_APPROVABLE` | `FOUR_EYES_VIOLATION` | `CHECKS_FAILED` (with the complete re-check result, so the panel replaces its checklist wholesale)).

### 2. Action + audit — `actions/billing/approve-run.action.ts`
`'use server'`: `requirePermission(PERMISSIONS.BILLRUN_APPROVE, LEVELS.EDIT)` → parse `{ billRunId }` → `approveRun` → `revalidatePath`. Add `BILL_RUN_APPROVED` (category `"Change"`) to `AUDIT_EVENT_TYPES` + `AUDIT_EVENT_CATEGORY_MAP` (+ coverage test).

### 3. Page + components — `app/(app)/billing/bill-runs/[runId]/approve/`
`page.tsx` (+ `loading.tsx`/`error.tsx`), `components/billing/{approve-and-post-panel,pre-approval-checks}.tsx`.

### 4. Tests — `tests/…`
- **[CRITICAL] Four-eyes:** approver == final trigger actor → `FOUR_EYES_VIOLATION` (service **and** DB CHECK); a different approver succeeds. `billrun_approve` required (an `operate`-only principal → `FORBIDDEN`).
- Each pre-approval check, when failing, blocks approval with its remediation (period closed; unresolved GL mapping; a zero/negative postable total; a non-terminal account).
- Approve stamps `approved_by`/`approved_at`/immutable `total_amount` (= sum of postable bills), marks `PROCESSING_FAILED`/`EXCLUDED` accounts `SKIPPED`, moves the run to `APPROVED`, writes `BILL_RUN_APPROVED`.
- `total_amount` is immutable after `APPROVED` (a later derive equals the stamp).

---

## Dependencies (packages to install)

**None.** Reuses the accounts period repository + GL resolution (bm09), `insertAuditEvent`, `zod`.

---

## Verification checklist

- [ ] Typecheck/lint/format clean; `BILL_RUN_APPROVED` in `AUDIT_EVENT_TYPES` + category map (+ coverage test); no new dependency.
- [ ] **Four-eyes** enforced in the service **and** by the `approver_distinct` DB CHECK; the UI disables Approve for the trigger actor with a reason.
- [ ] All five pre-approval checks render pass/fail + remediation; any failing check blocks approval (no state change).
- [ ] Approve stamps `approved_by`/`approved_at`/immutable `total_amount`, records `SKIPPED` for failed/excluded accounts, moves `PROCESSED → APPROVED`, audits `BILL_RUN_APPROVED`; posting is not performed here (bm11).
- [ ] `billrun_approve : EDIT` gates the page + action (route × level); the Approve confirm frames irreversibility + shows the skipped count.
- [ ] Docs updated same change set (`billmgmt-code-standards.md` §8 bm10 row + `billmgmt-progress-tracker.md`).
