# bm17 — `udr_rated` Approve/Reject/Release Lifecycle + Reject Action (with Approve/Reject Confirmations)

**Unit:** bm17 (Phase 2 · Phase G). **Boundary:** app operate/approve path — `db/repositories/billing/udr-status.repository.ts` (new, the app's only `rating.udr_rated` writer), `actions/billing/`, `services/billing/`, `components/billing/`. **Specs from:** `_updatemodule-billing-billrun-phase2-plan.md` §5/§15 **D11/D12/D14**, `billmgmt-architecture.md` Inv #2/#8/#14/#15, `bm00-build-plan.md` Unit 17. **Model (i) confirmed:** operator-reruns after reject; the run stays `PROCESSED`, approval gated by a check.

> **Workflow-management framing.** The bill run processor (bm16) claims `RATED → BILL_DRAFT`. This unit adds the **app-owned** half of the `udr_rated` lifecycle — the control-plane transitions the app makes at the human gates: approve (`→ BILL_APPROVED`), reject (`→ REJECTED`), and release on cancel (`→ RATED`). The processor never makes these; the app never claims.

## Goal

Introduce `udr-status.repository.ts` — the single app path that writes `rating.udr_rated`, column-scoped to the six claim columns — and wire it into approval (`BILL_DRAFT → BILL_APPROVED`), the new **Reject** action (`BILL_DRAFT → REJECTED`, `billrun_approve`), and cancel/release (`BILL_DRAFT → RATED`); gate approval behind a check so a rejected-pending-reprocess account can't be approved; and put **both Approve and Reject behind an explicit confirmation modal** so a mis-click can't commit either.

## Design

**The `udr_rated` transitions the app owns** (the processor owns only `RATED → BILL_DRAFT`):

| App action                            | Transition                   | Scope                            | Refused when                         |
| ------------------------------------- | ---------------------------- | -------------------------------- | ------------------------------------ |
| Approve (`billrun_approve`)           | `BILL_DRAFT → BILL_APPROVED` | the run's postable, claimed rows | never (approval is the gate)         |
| Reject (`billrun_approve`)            | `BILL_DRAFT → REJECTED`      | whole run or selected accounts   | row is `BILL_APPROVED`/posted (§D12) |
| Release on cancel (`billrun_operate`) | `BILL_DRAFT → RATED` (abort) | the cancelled run's rows         | row is on a posted invoice           |

All three go through **`udr-status.repository.ts`**, using `app_runtime`'s existing six-column grant (rating rm03) — no `INSERT`, no other column (Inv #2/#15). It is the phase-2 flip of the bm13 guardrail: from "no app `rating` write exists" to "exactly this one file writes it."

**Reject model (b) — operator reruns, run stays `PROCESSED`.** Reject is a pre-approval decline by a `billrun_approve` user on a `PROCESSED` run. Per rejected account, in one transaction:

1. `udr-status.markRejected` → `BILL_DRAFT → REJECTED` (parked, not-live).
2. Delete the account's **unposted** trial `customer_bill` (+ cascade tax items) — the finalization latch protects any posted row.
3. Stamp a **rejected marker** on the account's latest processing stage row: `error_code = 'REJECTED_PENDING_REPROCESS'`, `error_detail = <reason>` — the account stays at status `PROCESSED` (no new `AccountStatus` member; `REJECTED` lives on `udr_rated`, not the account), but it is now visibly _not_ approvable.
4. Write the `BILL_RUN_REJECTED` audit row (actor, accounts, prior totals, mandatory reason) **before** anything else in the transaction commits — same "audit-first" discipline as rerun (bm08).

The run **stays `PROCESSED`** (operable). A **new pre-approval check** blocks approval while any account carries the `REJECTED_PENDING_REPROCESS` marker. The **operator** then reruns those accounts (bm08, `billrun_operate`) → the processor's Collection stage re-claims `REJECTED → BILL_DRAFT` (bm16) → re-aggregates → the marker is cleared by the rerun → the run is fully approvable again. Reject → rerun → re-approve; segregation of duties intact.

**Confirmation modals (both gates).** Approve and Reject each open a **blocking confirmation modal** that names the action and its consequence and requires an explicit, distinct confirm — so a single stray click on the wrong button never commits:

- **Approve** — the money-gate modal (reinforces the as-built irreversibility framing): "Post {N} invoices totalling {amount}. Consumes invoice numbers, cannot be undone." Confirm is in the **danger role**, inside the modal, with the self-approval block visible.
- **Reject** — the `RejectDialog`: scope (whole run / selected accounts), a **mandatory reason**, and a spelled-out confirm ("Reject {N} accounts and send them back to reprocess. Their draft bills are discarded; an operator must rerun them before this run can be approved."). Confirm in the danger role.

## Implementation

### 1. `db/repositories/billing/udr-status.repository.ts` (new)

The app's only `UPDATE rating.udr_rated`. Three functions, each column-scoped and run inside the caller's transaction:

- `markApproved(tx, runId)` — `SET status='BILL_APPROVED', upsert_datetime=now() WHERE billrun_ref_id=runId AND status='BILL_DRAFT'`.
- `markRejected(tx, runId, banIds)` — `… status='REJECTED' … WHERE billrun_ref_id=runId AND billrun_ban_id = ANY(banIds) AND status='BILL_DRAFT'`.
- `release(tx, runId, banIds?)` — `… status='RATED', billrun_ref_id=NULL, billrun_ban_id=NULL, billrun_attempt=NULL, billrun_checksum=NULL … WHERE billrun_ref_id=runId (AND ban=ANY) AND status='BILL_DRAFT'` — never touches a `BILL_APPROVED`/posted row (the `status='BILL_DRAFT'` predicate guarantees it).

A grep-guard (bm13 flip) asserts this is the **only** file under `db/repositories/billing/` issuing a `rating.udr_rated` write.

### 2. Reject — action + service + validation

- `actions/billing/reject-run.action.ts` (`'use server'`, `billrun_approve`): parse `reject-run.schema.ts` (`runId`, `scope: 'all'|'selected'`, `banIds?`, mandatory `reason`), resolve principal, call the service.
- `services/billing/reject-run.ts`: one transaction — guard the run is `PROCESSED`; resolve the target accounts; **audit-first**; `udr-status.markRejected`; delete unposted trial bills (`customerBillRepository.deleteTrial`-style, `ref_inv_document_id IS NULL` guard); stamp the `REJECTED_PENDING_REPROCESS` marker on each account's latest stage row; recompute run status under the row lock (stays `PROCESSED`).
- `validation/billing/reject-run.schema.ts` — Zod; empty reason → `VALIDATION_ERROR` (matches the rerun convention).

### 3. Approve — flip `BILL_APPROVED` + reject-gate check

- `services/billing/approve-run.ts` (bm10): inside the existing approve transaction, after the four-eyes + pre-approval checks pass and `total_amount` is stamped, call `udr-status.markApproved(tx, runId)` to flip the run's claimed rows `BILL_DRAFT → BILL_APPROVED`.
- `services/billing/pre-approval-checks.ts`: add a **6th check** `no_rejected_pending` — fails if any account carries `error_code='REJECTED_PENDING_REPROCESS'`, with remediation "Rerun the rejected accounts, then approve." Add `'no_rejected_pending'` to `PRE_APPROVAL_CHECKS` in `types/billing.ts`.

### 4. Cancel + rerun wiring

- `services/billing/cancel-run.ts` (bm12): add `udr-status.release(tx, runId)` so a cancel returns the claimed rows to `RATED` (abort, D11) — distinct from reject's `REJECTED`.
- `services/billing/rerun-run.ts` (bm08): when a rerun includes a rejected account, it clears the `REJECTED_PENDING_REPROCESS` marker as part of the re-trigger; the processor's Collection stage re-claims `REJECTED → BILL_DRAFT` (bm16 — no app release needed, the flow re-claims). A rerun's eligible set already excludes posted/`EXCLUDED` accounts (bm08); it now also includes rejected accounts.

### 5. UI — Reject dialog + confirmations

- `components/billing/reject-dialog.tsx` (new, `RejectDialog`): scope radios (whole run / selected — reuse the `RerunDialog` selection pattern), mandatory reason, danger-role confirm, spelled-out consequence copy (`billmgmt-ui-context.md` §7). Reachable from the run-detail header and the Approve & Post page.
- Wire a **Reject** control next to **Approve & Post** (run header + approve page), each opening its confirmation modal; the Approve modal keeps its checkbox + irreversibility framing and the self-approval block. Never a bare row action for either.
- Show the rejected-pending accounts on the run detail (e.g. an "Errors"/"Rejected" surface or a marker on Customers & Bills) with a "Rerun to reprocess" hint for a `billrun_view` viewer.

### 6. Audit

- New event type `BILL_RUN_REJECTED` (add to the module's audit vocabulary and, if the four-eyes barred-actor set should include rejecters, evaluate against `TRIGGER_EVENT_TYPES` — **decision:** reject is an approver action, so it does **not** bar the rejecter from later approving; it is audited but not added to `TRIGGER_EVENT_TYPES`).

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm16 (the `BILL_DRAFT` claim exists and the Collection stage re-claims `REJECTED`/`RATED`); bm14 (`app_runtime` already holds the six-column grant via rating rm03 — no new grant here); phase-1 approve (bm10), rerun (bm08), cancel (bm12), the `customer_bill` delete-trial path (bm05).

## Verification checklist

- [ ] `udr-status.repository.ts` is the **only** app file writing `rating.udr_rated` (grep-guard); `markApproved`/`markRejected`/`release` touch only the six claim columns and never a `BILL_APPROVED`/posted row.
- [ ] **Approve** flips the run's `BILL_DRAFT` rows → `BILL_APPROVED` inside the approve transaction; a rollback leaves them `BILL_DRAFT`.
- [ ] **Reject** (`billrun_approve`, whole-run and selected) flips the target rows → `REJECTED`, deletes their unposted trial bills, stamps `REJECTED_PENDING_REPROCESS`, writes the audit row **first**, and leaves the run `PROCESSED`; a `billrun_operate` user cannot reject; a `billrun_view` user sees neither action.
- [ ] The `no_rejected_pending` pre-approval check **blocks approval** while a rejected account exists, with its remediation line; approving is refused server-side even if the UI is bypassed.
- [ ] A **rerun** of a rejected account re-claims `REJECTED → BILL_DRAFT` (via the processor), clears the marker, and re-enables approval; reject → rerun → re-approve completes.
- [ ] **Cancel** releases the run's claimed rows `BILL_DRAFT → RATED` (distinct from reject's `REJECTED`); release is refused for rows on a posted invoice.
- [ ] **Confirmation modals:** both Approve and Reject require an explicit in-modal confirm (danger role); neither commits from a single click on the primary button; reject requires a non-empty reason; the self-approval block still renders on Approve.
- [ ] `BILL_RUN_REJECTED` audit row carries actor + accounts + reason; reject does not bar the rejecter from approving a later attempt.
- [ ] `tsc`/lint/tests green (incl. the route × level matrix for the new reject action); `billmgmt-progress-tracker.md` updated (bm17 delivered).

## Phase-2 review folds (2026-08-28)

**T6 (P2, eng §16) — re-claim contract (paired with bm16).** The flow is the sole re-claimer: on reprocess it claims `status IN ('RATED','REJECTED') → BILL_DRAFT` and re-stamps `billrun_attempt` to the current run attempt; the app never claims (it only sets `BILL_APPROVED`/`REJECTED`/release). This unit's §4 "the flow re-claims, no app release needed" is authoritative; bm16 §3's stub is corrected to match. Additionally, **pin the reject-marker lifecycle**: the `REJECTED_PENDING_REPROCESS` marker sits on the account's latest processing stage row, and the rerun's stage-invalidation must clear exactly that row (confirm the rerun's `> N` invalidation covers the marked stage for the rejected account). Verification addition: reject → rerun clears the marker on the correct stage row and re-enables approval; posting after reprocess reads the re-stamped attempt.
