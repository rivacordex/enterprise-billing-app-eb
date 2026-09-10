import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { udrStatusRepository } from "@/db/repositories/billing/udr-status.repository";
import type { RejectScope } from "@/validation/billing/reject-run.schema";

// bm17-spec §Design "Reject model (b) — operator reruns, run stays
// PROCESSED". Reject is a pre-approval decline by a `billrun_approve` user on
// a `PROCESSED` run's postable (`PROCESSED`) accounts. Per rejected account,
// in one `db.transaction`:
//   1. AUDIT FIRST — `BILL_RUN_REJECTED` (prior totals + mandatory reason),
//      same "audit-first" discipline as rerun (bm08) — committed before any
//      of the writes below.
//   2. `udr-status.markRejected` → the run's claimed `BILL_DRAFT` rows for
//      the rejected accounts flip to `REJECTED` (parked, not-live).
//   3. Delete the rejected accounts' UNPOSTED trial `customer_bill` rows
//      (tax items cascade, bm06) — the finalization latch still protects any
//      posted row.
//   4. Stamp the `REJECTED_PENDING_REPROCESS` marker on each account's
//      latest (current-attempt) stage row. `bill_run_account.status` is left
//      UNTOUCHED (still `PROCESSED` — no new `AccountStatus` member); the
//      run stays `PROCESSED` throughout, operable for an operator rerun.
// Only `PROCESSED` accounts are reject-eligible: a `PROCESSING_FAILED`/
// `EXCLUDED` account has no trial bill and is already headed for `SKIPPED`
// at approval, not "sent back to reprocess". A posted account (impossible
// pre-approval, belt-and-suspenders with bm08's rerun guard) is dropped too.

export type RejectRunResult =
  | {
      ok: true;
      value: { billRunId: string; accountCount: number; priorTotals: string };
    }
  | { ok: false; code: "NOT_REJECTABLE" }
  | { ok: false; code: "NO_ACCOUNTS_SELECTED" };

export interface RejectRunParams {
  billRunId: string;
  scope: RejectScope;
  banIds: string[];
  reason: string;
}

export async function rejectRun(
  params: RejectRunParams,
  actorId: string,
): Promise<RejectRunResult> {
  return db.transaction(async (tx) => {
    const run = await billRunRepository.findByIdForUpdate(tx, params.billRunId);
    if (!run || run.status !== "PROCESSED") {
      return { ok: false, code: "NOT_REJECTABLE" } as const;
    }

    const [accounts, postedIds] = await Promise.all([
      billRunAccountRepository.listForRerun(tx, run.billRunId),
      customerBillRepository.listPostedAccountIds(tx, run.billRunId),
    ]);
    const posted = new Set(postedIds);
    const requested = new Set(params.banIds);
    const eligible = accounts.filter(
      (a) =>
        a.status === "PROCESSED" &&
        !posted.has(a.billingAccountId) &&
        (params.scope === "all" || requested.has(a.billingAccountId)),
    );
    if (eligible.length === 0) {
      return { ok: false, code: "NO_ACCOUNTS_SELECTED" } as const;
    }

    const banIds = eligible.map((a) => a.billingAccountId);
    const priorTotals = await customerBillRepository.sumTotalsForAccounts(
      tx,
      run.billRunId,
      banIds,
    );

    // 1. AUDIT FIRST — committed before any of the reject writes below.
    await insertAuditEvent(tx, {
      eventType: "BILL_RUN_REJECTED",
      actorUserId: actorId,
      targetEntity: "BILL_RUN",
      targetId: run.billRunId,
      beforeData: { priorTotals },
      afterData: { accounts: banIds, reason: params.reason },
    });

    // 2 + 3. Flip the claim to REJECTED and drop the unposted trial bills.
    await udrStatusRepository.markRejected(tx, run.billRunId, banIds);
    await customerBillRepository.deleteUnpostedForAccounts(
      tx,
      run.billRunId,
      banIds,
    );

    // 4. Stamp the marker on each account's own latest (current-attempt)
    // stage row — per-account, since each account's attempt/stage row
    // resolves independently.
    for (const account of eligible) {
      const stageRow = await billRunAccountStageRepository.findLatestForAccount(
        tx,
        run.billRunId,
        account.billingAccountId,
        account.attemptCount,
      );
      // A PROCESSED account always has a stage row for its current attempt
      // (the verification-stage signal that advances it to PROCESSED inserts
      // one first) — a missing row here is an invariant violation, not a
      // normal case. The `no_rejected_pending` approval gate (bm17-spec)
      // reads ONLY this marker, not `udr_status`; silently skipping it would
      // let a "rejected" account (claim released, trial bill deleted) slip
      // past approval with nothing to flag it for rerun. Fail the whole
      // reject rather than leave that gap.
      if (!stageRow) {
        throw new Error(
          `Bill-run reject: no stage row found for account ${account.billingAccountId} at attempt ${account.attemptCount} (run ${run.billRunId}).`,
        );
      }
      await billRunAccountStageRepository.stampMarker(
        tx,
        stageRow.billRunAccountStageId,
        stageRow.periodPartition,
        params.reason,
      );
    }

    return {
      ok: true,
      value: {
        billRunId: run.billRunId,
        accountCount: banIds.length,
        priorTotals,
      },
    } as const;
  });
}
