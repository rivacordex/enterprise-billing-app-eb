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
// (`RATED`/`REJECTED` → `BILL_DRAFT`, bm14's `billrun_status_guard` trigger
// enforces this DB-side for that role); the app owns the three human-gate
// transitions here and never claims.
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

  // Reject — BILL_DRAFT → REJECTED (parked, not-live), scoped to the
  // rejected accounts only (whole-run reject resolves every postable account
  // as `banIds` at the caller, never an unscoped run-wide write).
  async markRejected(
    tx: Database,
    billRunId: string,
    banIds: string[],
  ): Promise<void> {
    if (banIds.length === 0) return;
    await tx
      .update(udrRated)
      .set({ status: "REJECTED", upsertDatetime: sql`now()` })
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
