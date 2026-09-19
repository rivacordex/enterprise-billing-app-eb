# bm10 — Approve (four-eyes gate) — Spec

**Unit:** bm10 (`bm00-build-plan.md`). **Boundary:** `bill-runs` approve path. **Depends on:** bm09 (GL mappings + period state for the checks), bm05–bm07 (bills, terminal accounts).
**Grounded in** `F:/Projects/enterprise-billing-app/`: the action→dialog→service(txn)→`insertAuditEvent`→`revalidatePath` template (`services/accounts/close-billing-account.ts`), `accounting-period.repository.findByPeriodAndCurrency`, the `gl_resolution_view`/GL-resolution read (bm09), `bill_run.approver_distinct` CHECK (bm02), `types/audit.ts`.

---

## Goal

A **different** approver (≠ the final trigger actor) opens **Approve & Post**, sees the pre-approval checklist — the **six blocking checks** (accounting period open, GL mappings resolvable, no negative totals on billed accounts, approver ≠ trigger actor, all accounts terminal, no accounts pending reprocess) plus **two informational lines** (orphaned-usage count, zero-total bills) — and approves — stamping `approved_by`/`approved_at`/the immutable `total_amount` and moving the run `PROCESSED → APPROVED`; failed/excluded accounts are recorded `SKIPPED`. (Posting itself is bm11.)

---

## Design

### Structural
- **Precondition:** run `status = 'PROCESSED'`, every account terminal (`PROCESSED`/`PROCESSING_FAILED`/`EXCLUDED`).
- **Four-eyes (segregation of duties):** the approver ≠ the user who triggered the **final** attempt (`bill_run.triggered_by`) — enforced in the **service layer** (typed `FOUR_EYES_VIOLATION`) and backed by the `bill_run.approver_distinct` DB CHECK (bm02). The UI additionally disables Approve for the trigger actor with a reason (show/hide only).
- **Pre-approval checks** — **six blocking checks (1–6, all must pass)** plus **two informational lines (7–8)**; each renders pass/fail + remediation, `services/billing/pre-approval-checks.ts`:
  1. **Accounting period open** (`period_open`) — `accountingPeriodRepository.findByPeriodAndCurrency(periodKeyFor(gl_event_at), currency)` is not `closed` (an absent row = open).
  2. **GL mappings resolvable** (`gl_mappings`) — the INV revenue + tax mappings resolve (bm09's `gl_resolution`); an unresolved mapping blocks.
  3. **No negative totals on billed accounts** (`positive_totals`) — a backstop; any postable bill whose `subtotal`/`total_amount` is **negative** blocks (a bill is never a negative amount — that is a credit, and there is no credit-note path). **SIGN-BASED, AMENDED 2026-09-17 (owner decision): zero no longer blocks.** The original premise — "zero-charge accounts were excluded at Scoping" — was true at bm10 but was invalidated by **bm32**, which redefined Uncharged (Inv #22): a zero-charge account is now scoped, runs every stage, reaches `PROCESSED`, and is surfaced on the Uncharged tab, while the processor still writes an unconditional `subtotal-0.00` header for it (its own documented "deferred limitation"). The old `<= 0` backstop fired on a shape it was never written for and made **any run containing a no-charges account permanently unapprovable** — including the `ci` sample seed's `BAN…04`. Keying on the **sign** rather than line-presence means a zero bill — line-less **or** a fully-discounted net-zero — is treated as an ordinary zero: not posted (`post-run.ts` skips it, so no INV and no ledger entry) and reported by the informational `zero_total_bills` line (8) instead of wedging the run. **Accepted consequence:** the line-less header is no longer stopped here, so it reaches posting and would consume an invoice number for a 0.00 INV unless `document_line_amount_check` (`amount > 0`) rejects it first and parks the account. The durable fix — stop the processor writing the header at all — is recorded as open in `billmgmt-progress-tracker.md`.
  4. **Approver ≠ trigger actor** (`four_eyes`) — the approver must differ from every operator who triggered **or reran** the run (resolved from the `BILL_RUN_TRIGGERED`/`BILL_RUN_RERUN` audit trail, union'd with `bill_run.triggered_by`), backed by the `bill_run.approver_distinct` DB CHECK.
  5. **All accounts terminal** (`accounts_terminal`).
  6. **No accounts pending reprocess** (`no_rejected_pending`, bm17) — blocks while any account still carries the `REJECTED_PENDING_REPROCESS` marker on its current-attempt latest stage row; the rerun's attempt bump clears it implicitly (no explicit "clear" write). Remediation: rerun the rejected accounts, then approve.
  7. **Orphaned-usage count (INFORMATIONAL, bm32).** (`orphan_count`) The count of the run window's unclaimed live `RATED` `RAN_USAGE` rows — the same ORPHAN set the exception surface lists. Rides the `informational` contract — always `pass`es, excluded from `approveRun`'s `CHECKS_FAILED` gate (D32/Inv #25); a run bills fine with orphans present (the next run claims them once the inventory is fixed).
  8. **Zero-total bills (INFORMATIONAL, added 2026-09-17).** (`zero_total_bills`) The count of **every** postable bill whose `total_amount` is exactly zero (line-less or not). Rides the bm32 `informational` contract — always `pass`es, excluded from `approveRun`'s `CHECKS_FAILED` gate, rendered as an Info line whose text shows even when passing. It is the visible counterpart to narrowing check 3: zero totals stop blocking, but they must not become invisible to the approver signing the money gate.
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
- Each pre-approval check, when failing, blocks approval with its remediation (period closed; unresolved GL mapping; a negative postable total; a non-terminal account; an account pending reprocess).
- Approve stamps `approved_by`/`approved_at`/immutable `total_amount` (= sum of postable bills), marks `PROCESSING_FAILED`/`EXCLUDED` accounts `SKIPPED`, moves the run to `APPROVED`, writes `BILL_RUN_APPROVED`.
- `total_amount` is immutable after `APPROVED` (a later derive equals the stamp).

---

## Dependencies (packages to install)

**None.** Reuses the accounts period repository + GL resolution (bm09), `insertAuditEvent`, `zod`.

---

## Verification checklist

- [ ] Typecheck/lint/format clean; `BILL_RUN_APPROVED` in `AUDIT_EVENT_TYPES` + category map (+ coverage test); no new dependency.
- [ ] **Four-eyes** enforced in the service **and** by the `approver_distinct` DB CHECK; the UI disables Approve for the trigger actor with a reason.
- [ ] All five **blocking** pre-approval checks render pass/fail + remediation; any failing check blocks approval (no state change) — but a line-less zero bill does **not** block (check 3 only fires on a bill carrying `customer_bill_line` entries whose `total_amount <= 0`). The sixth **informational** zero-total line always passes and is excluded from `CHECKS_FAILED`.
- [ ] Approve stamps `approved_by`/`approved_at`/immutable `total_amount`, records `SKIPPED` for failed/excluded accounts, moves `PROCESSED → APPROVED`, audits `BILL_RUN_APPROVED`; posting is not performed here (bm11).
- [ ] `billrun_approve : EDIT` gates the page + action (route × level); the Approve confirm frames irreversibility + shows the skipped count.
- [ ] Docs updated same change set (`billmgmt-code-standards.md` §8 bm10 row + `billmgmt-progress-tracker.md`).
