import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { runPreApprovalChecks } from "@/services/billing/pre-approval-checks";
import type { PreApprovalCheck } from "@/types/billing";

// bm10-spec §Design/§Implementation §1. The approve transaction — the
// four-eyes money gate. One `db.transaction`:
//   1. `SELECT … FOR UPDATE` the run → guard `status = 'PROCESSED'`.
//   2. Run all five pre-approval checks (fail → typed result, no state
//      change). Four-eyes gets its own result code (`FOUR_EYES_VIOLATION`,
//      backed by the DB CHECK too); the other four bucket under
//      `CHECKS_FAILED`.
//   3. Stamp `approved_by`/`approved_at`/the immutable `total_amount` (the
//      SQL sum of the postable — non-SKIPPED — bills).
//   4. Mark every `PROCESSING_FAILED`/`EXCLUDED` account `SKIPPED`.
//   5. Flip the run `PROCESSED → APPROVED`.
//   6. `insertAuditEvent(BILL_RUN_APPROVED)`.
// Posting (`APPROVED → POSTING → INVOICED`) is bm11 — this stops at APPROVED.

export type ApproveRunResult =
  | {
      ok: true;
      value: { billRunId: string; totalAmount: string; skippedCount: number };
    }
  | { ok: false; code: "NOT_APPROVABLE" }
  | { ok: false; code: "FOUR_EYES_VIOLATION" }
  | { ok: false; code: "MULTI_CURRENCY" }
  | { ok: false; code: "CHECKS_FAILED"; checks: PreApprovalCheck[] };

export async function approveRun(
  billRunId: string,
  actorId: string,
): Promise<ApproveRunResult> {
  return db.transaction(async (tx) => {
    const run = await billRunRepository.findByIdForUpdate(tx, billRunId);
    if (!run || run.status !== "PROCESSED") {
      return { ok: false, code: "NOT_APPROVABLE" } as const;
    }

    const checks = await runPreApprovalChecks(tx, run, actorId);
    const fourEyes = checks.find((c) => c.check === "four_eyes");
    if (fourEyes && !fourEyes.pass) {
      return { ok: false, code: "FOUR_EYES_VIOLATION" } as const;
    }
    const failing = checks.filter((c) => !c.pass);
    if (failing.length > 0) {
      // Return the COMPLETE re-check result (not just the failing subset) so the
      // panel can replace its checklist wholesale — a check that was failing at
      // page-load but now passes is cleared rather than left stale.
      return { ok: false, code: "CHECKS_FAILED", checks } as const;
    }

    // Single-currency-per-cycle is a v1 invariant, but `sumPostableTotalForRun`
    // adds bills across currencies blindly — refuse to stamp a meaningless
    // cross-currency total (and its single-currency label) if the invariant is
    // ever violated. Read-only, before any write, so returning here is safe.
    const currencies = await customerBillRepository.listPostableCurrencies(
      tx,
      run.billRunId,
    );
    if (currencies.length > 1) {
      return { ok: false, code: "MULTI_CURRENCY" } as const;
    }

    const totalAmount = await customerBillRepository.sumPostableTotalForRun(
      tx,
      run.billRunId,
    );
    const skippedCount = await billRunAccountRepository.markSkippedForRun(
      tx,
      run.billRunId,
    );
    const approved = await billRunRepository.approve(tx, run.billRunId, {
      approvedBy: actorId,
      totalAmount,
    });
    if (!approved) {
      // The status precondition failed at write time despite the FOR UPDATE
      // lock and the guard above — throw so the whole transaction (including
      // `markSkippedForRun`) rolls back rather than auditing a no-op approval.
      throw new Error(
        `approveRun: bill_run ${run.billRunId} was not PROCESSED at write time`,
      );
    }

    await insertAuditEvent(tx, {
      eventType: "BILL_RUN_APPROVED",
      actorUserId: actorId,
      targetEntity: "BILL_RUN",
      targetId: run.billRunId,
      beforeData: { status: run.status },
      afterData: { status: "APPROVED", totalAmount, skippedCount },
    });

    return {
      ok: true,
      value: { billRunId: run.billRunId, totalAmount, skippedCount },
    } as const;
  });
}
