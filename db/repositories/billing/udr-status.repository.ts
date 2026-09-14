import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { udrRated } from "@/db/schema/rating/udr-rated";

// bm17-spec §Design/§Implementation §1. The app's ONLY `UPDATE rating.
// udr_rated` — the phase-2 flip of the bm13 guardrail (`tests/guardrails/
// billing-rating-write-boundary.test.ts`): from "no app `rating` write
// exists" to "exactly this one file writes it". Column-scoped to the same
// six claim columns `app_runtime` holds via rating rm03 (`status`,
// `upsert_datetime`, `billrun_ref_id`, `billrun_ban_id`, `billrun_attempt`,
// `billrun_checksum`) — no `INSERT`, no other column. Every function runs
// inside the CALLER's transaction (approve/reject/cancel own the txn).
//
// The processor (as `billrun_runtime`) owns the ONE claim transition
// (`RATED` → `BILL_DRAFT`, bm14's `billrun_status_guard` trigger enforces this
// DB-side for that role — narrowed by bm25 from the former `RATED`/`REJECTED`
// source set now that reject/rerun/cancel RELEASE to `RATED`, see line ~51 and
// `billrun-db-roles.sql` Step 7b); the app owns the three human-gate transitions
// here and never claims.
export const udrStatusRepository = {
  // Approve — the run's claimed rows flip BILL_DRAFT → BILL_APPROVED. Scoped
  // to the run only (every claimed row is postable by the time approval is
  // reached, bm10's pre-approval checks).
  async markApproved(tx: Database, billRunId: string): Promise<void> {
    await tx
      .update(udrRated)
      .set({ status: "BILL_APPROVED", upsertDatetime: sql`now()` })
      .where(
        and(
          eq(udrRated.billrunRefId, billRunId),
          eq(udrRated.status, "BILL_DRAFT"),
        ),
      );
  },

  // Reject — bm24-spec §Implementation §1 (D21): an account-scoped RELEASE,
  // `BILL_DRAFT → RATED` with the four claim columns NULLed (was the old
  // `→ REJECTED` status flip). Once Collection narrows to `RATED` only (bm27),
  // a `REJECTED` row would be unclaimable and silently strand the account's
  // charges (Inv #19); releasing to `RATED` lets the operator's rerun re-claim
  // the complete set. Functionally identical to `release(tx, runId, banIds)`
  // for a NON-EMPTY `banIds` — but the two diverge on the empty case (this
  // early-returns a no-op; `release([])` drops the `inArray` and releases the
  // WHOLE run), so collapsing them (spec §1 flags it as optional later
  // cleanup) must NOT be a blind call-swap. The name is retained for
  // `reject-run.ts`'s call-site clarity and to leave the write-boundary
  // guardrail's assertion set untouched. The
  // `REJECTED_PENDING_REPROCESS` stage marker (bm17) — not `udr_status` — is
  // what bars approval until the account is reprocessed. Scoped to the rejected
  // accounts only (whole-run reject resolves every postable account as
  // `banIds` at the caller, never an unscoped run-wide write). No billing code
  // writes `udr_rated.status = 'REJECTED'` anymore (bm25 narrows the now-
  // vestigial rating CHECK + `billrun_status_guard` allowance).
  async markRejected(
    tx: Database,
    billRunId: string,
    banIds: string[],
  ): Promise<void> {
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
  },

  // Release on cancel — BILL_DRAFT → RATED (abort, D11), clearing the claim
  // columns so the row is unclaimed and re-claimable by a future run. The
  // `status = 'BILL_DRAFT'` predicate is what guarantees this never touches a
  // `BILL_APPROVED`/posted row — no separate posted-row check is needed.
  // `banIds` omitted ⇒ every claimed row in the run (cancel's whole-run
  // release); passed ⇒ scoped to those accounts only.
  async release(
    tx: Database,
    billRunId: string,
    banIds?: string[],
  ): Promise<void> {
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
          eq(udrRated.status, "BILL_DRAFT"),
          ...(banIds && banIds.length > 0
            ? [inArray(udrRated.billrunBanId, banIds)]
            : []),
        ),
      );
  },
};
