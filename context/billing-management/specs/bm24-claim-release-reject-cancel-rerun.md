# bm24 — Claim Release on Reject, Cancel & Rerun

**Unit:** bm24 (Phase 3 · Phase K). **Boundary:** `db/repositories/billing/udr-status.repository.ts` (the app's sole `rating.udr_rated` writer — modified under its own mandate) + `services/billing` (`reject-run.ts`, `rerun-run.ts`; `cancel-run.ts` verified unchanged). **No new table, schema, flow, or UI.** **Specs from:** `billmgmt-architecture.md` §6 **Inv #19** (release on reject/cancel/rerun, before re-trigger), `_updatemodule-billing-billrun-phase3-plan.md` **D21**, `billmgmt-code-standards.md` §1.4, `bm00-build-plan.md` Unit 24.

> **Framing.** In Phase 3, Collection's claimable set **narrows to `RATED`** (bm27). Today, reject flips claimed rows to `REJECTED` (keeping the claim columns) and the re-triggered processor re-claims from `REJECTED`; rerun does no release at all, leaving it to the processor. Once Collection reads `RATED` only, either path can strand a `BILL_DRAFT` row from an abandoned attempt — unclaimable, silently under-billing the customer (D21, Inv #19). This unit makes **reject, cancel and rerun all release the claim back to `RATED`** (clearing the four claim columns), and makes rerun release **before** the re-trigger, never after — the lifecycle-correctness fix that must land before any real claim runs.

## Goal

Change the app's rating writer and the rerun service so that every abandon path returns claimed `udr_rated` rows to `RATED` with the four claim columns (`billrun_ref_id`, `billrun_ban_id`, `billrun_attempt`, `billrun_checksum`) NULLed: reject releases the rejected accounts' rows (was `→ REJECTED`), rerun releases the selected accounts' prior-attempt rows **before** re-triggering the engine, and cancel already releases the whole run — so no `BILL_DRAFT` row can survive an abandoned attempt to become unclaimable when Collection narrows to `RATED`.

## Design

**Structural decisions**

- **Reject releases to `RATED`, not `REJECTED` (D21).** `markRejected` becomes an account-scoped **release**: `status → RATED` + the four claim columns NULLed + `upsert_datetime = now()`, guarded by `status = 'BILL_DRAFT'`. It is now functionally identical to `release(tx, runId, banIds)`; the name is retained so `reject-run.ts`'s call site and the write-boundary guardrail are untouched. Consequence: **no billing code writes `udr_rated.status = 'REJECTED'` anymore** — the rating CHECK still admits it (rm01) and the `billrun_status_guard` still permits `REJECTED → BILL_DRAFT`, but both become vestigial and are narrowed in bm25 (which depends on this unit).
- **The marker is the sole approval-gate signal (already true, now load-bearing).** `checkNoRejectedPending` reads only the `REJECTED_PENDING_REPROCESS` stage marker on the account's current-attempt row — never `udr_status`. That was already the case (bm17); it becomes essential here because a rejected account's rows are now indistinguishable at `RATED` from never-claimed rows, so the marker is the only thing that bars approval until the account is reprocessed. The attempt-keyed join in `listRejectedPendingForRun` still clears the marker implicitly on the rerun's attempt bump (T6) — unchanged.
- **Rerun releases before the re-trigger, never after (Inv #19, D21).** The current rerun no-op ("release/re-claim is the processor's concern") is replaced by an explicit `release(tx, runId, banIds)` **between the attempt bump and the engine trigger**. This drains any prior-attempt `BILL_DRAFT` row — including one stranded by a partial `PROCESSING_FAILED` — back to `RATED` so the re-triggered Collection (which reads `RATED` only, bm27) re-claims the complete set. Ordering is the invariant: release after a re-trigger races the processor's fresh claim.
- **Cancel already conforms.** `cancel-run.ts` calls `release(tx, billRunId)` (whole-run) alongside `resetForCancel`; this unit verifies it and adds it to the regression, no code change.
- **Within the six-column boundary, unchanged surface.** Every write stays inside the write-boundary guardrail's `ALLOWED_KEYS` (`status`, `upsertDatetime`, `billrunRefId`, `billrunBanId`, `billrunAttempt`, `billrunChecksum`) — no INSERT, no new column, no second rating writer. The DB grant (`app_runtime`'s six-column UPDATE, unconstrained by `billrun_status_guard` which only binds `billrun_runtime`) already permits the `BILL_DRAFT → RATED` release.

## Implementation

### 1. `db/repositories/billing/udr-status.repository.ts` — `markRejected` becomes a release

Change `markRejected`'s body from the `→ REJECTED` status flip to the account-scoped release already implemented by `release`:

```ts
async markRejected(tx: Database, billRunId: string, banIds: string[]): Promise<void> {
  if (banIds.length === 0) return;
  await tx
    .update(udrRated)
    .set({
      status: "RATED",
      billrunRefId: null,
      billrunBanId: null,
      billrunAttempt: null,
      billrunChecksum: null,
      upsertDatetime: sql`now()`,
    })
    .where(
      and(
        eq(udrRated.billrunRefId, billRunId),
        inArray(udrRated.billrunBanId, banIds),
        eq(udrRated.status, "BILL_DRAFT"),
      ),
    );
}
```

`markApproved` (`BILL_DRAFT → BILL_APPROVED`) and `release` are unchanged. (`markRejected` is now equivalent to `release(tx, runId, banIds)`; kept as a distinct name for call-site clarity and to leave the write-boundary guardrail's assertion set untouched — collapsing the two is an optional later cleanup, not part of this unit.)

### 2. `services/billing/reject-run.ts` — no structural change; semantics follow §1

The call `udrStatusRepository.markRejected(tx, run.billRunId, banIds)` now releases those accounts' rows to `RATED` (was `REJECTED`). The unposted trial-bill delete (`customerBillRepository.deleteUnpostedForAccounts`) and the `REJECTED_PENDING_REPROCESS` marker stamping on each account's current-attempt stage row are unchanged — the marker remains the approval-gate signal. After this unit, a rejected account carries: rows at `RATED` (unclaimed), no trial bill, and the marker; the run stays `PROCESSED` (reject model (b)).

### 3. `services/billing/rerun-run.ts` — release before the re-trigger

Replace the "release is the processor's concern" no-op comment (currently between the attempt bump and the engine trigger) with an explicit release of the rerun's selected accounts, **before** `engineRegistry.trigger(...)`:

```ts
// Release the prior attempt's claimed rows back to RATED BEFORE re-trigger
// (Inv #19 / D21) — Collection re-claims RATED only (bm27), so any BILL_DRAFT
// stranded by an abandoned/partial-failed prior attempt must be drained here,
// never left for (or raced by) the re-triggered processor.
await udrStatusRepository.release(tx, run.billRunId, banIds);
```

Placed after `billRunAccountRepository.setAttemptForRerun(...)` and before the engine trigger, inside the same transaction (the trigger is inside the txn; an unreachable engine rolls the release back with everything else). The re-triggered execution then re-claims `RATED → BILL_DRAFT` under the new attempt and re-aggregates via the whole-account replace, as today.

### 4. `services/billing/cancel-run.ts` — verified, unchanged

`cancel-run.ts` already calls `udrStatusRepository.release(tx, billRunId)` (whole-run) after `resetForCancel` and before `bill_run.cancel`. No change; added to the regression (§5) so the three abandon paths are proven together.

### 5. Guardrail / regression — extend the DB-gated suite

- **[CRITICAL] No claim survives an abandoned attempt.** In `tests/db/billing-e2e-happy-path.integration.test.ts` (or a focused `tests/db/*.integration.test.ts`): drive an account to a **partial** `PROCESSING_FAILED` (some rows claimed to `BILL_DRAFT`, no complete bill), then rerun it — assert **no** `udr_rated` row remains at `BILL_DRAFT` from the prior attempt, and the re-run bill contains **every** charge the first attempt claimed.
- **Reject releases to `RATED`.** After rejecting an account, its `udr_rated` rows are at `RATED` with the four claim columns NULL (not `REJECTED`), the trial bill is gone, and the `REJECTED_PENDING_REPROCESS` marker bars approval (`checkNoRejectedPending` fails) until a rerun reprocesses it.
- **Cancel releases the whole run** to `RATED`.
- **Write-boundary guardrail unchanged** — `tests/guardrails/billing-rating-write-boundary.test.ts` still passes: no INSERT, every `.set()` within `ALLOWED_KEYS`.

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm22 (a real Postgres to execute the DB-gated regression); bm17 (`udr-status.repository.ts`, `reject-run.ts`, the `REJECTED_PENDING_REPROCESS` marker + `checkNoRejectedPending`) and bm08 (`rerun-run.ts`), both delivered.
- **Sequencing:** must land **before** bm27 (Collection narrows to `RATED`) — the whole reason for the unit. bm25 depends on this unit and then narrows `billrun_status_guard` to `RATED → BILL_DRAFT`, retiring the now-unused `REJECTED → BILL_DRAFT` allowance.

## Verification checklist

- [ ] `markRejected` releases the rejected accounts' rows to `RATED` (four claim columns NULLed), guarded by `status = 'BILL_DRAFT'`; no billing code writes `udr_rated.status = 'REJECTED'` anymore.
- [ ] Rerun calls `release(tx, runId, banIds)` **before** `engineRegistry.trigger`, inside the trigger transaction; an unreachable engine rolls the release back.
- [ ] **[CRITICAL]** After a rerun following a partial processing failure, no `udr_rated` row remains at `BILL_DRAFT` from the prior attempt, and the re-run bill contains every charge the first attempt claimed.
- [ ] A rejected account cannot be approved until reprocessed (the marker bars `checkNoRejectedPending`); after rerun's attempt bump the marker clears implicitly.
- [ ] Cancel releases the whole run's claimed rows to `RATED`.
- [ ] `tests/guardrails/billing-rating-write-boundary.test.ts` passes unchanged (six-column boundary, no INSERT, single sanctioned writer).
- [ ] `tsc`/lint/tests green; `billmgmt-progress-tracker.md` records bm24 delivered and notes the now-vestigial `REJECTED` status handed to bm25 for the guard narrowing.
