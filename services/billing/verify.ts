import type { Database } from "@/db/client";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import type { BillRun } from "@/db/schema/billing/bill-run";
import type { ErrorClass, StageStatus } from "@/types/billing";

// bm07-spec §Design/§Implementation §1. The Verification stage (stage 6) —
// the ONE remaining stage whose outcome the app computes itself, replacing
// bm04's record-and-advance pass-through (`handle-stage-signal.ts`), joining
// Validation/Collection as an app-computed override.
//
// v1 is deliberately minimal: with synthetic stub figures and no prior-period
// baseline, plausibility/variance checks are deferred with the rating engine.
// The stage ALWAYS records DONE (it never fails or blocks the run); a single
// cheap backstop — the account's unposted bill total being `<= 0`, which should
// never happen with stub figures — raises a `SOFT` finding recorded ON this
// same stage row (`error_class = 'SOFT'`, `error_code`). Findings are SOFT
// stage rows, not a new table (spec §Design "No new findings table").

export interface VerifyAccountResult {
  status: Extract<StageStatus, "DONE">;
  errorClass: ErrorClass | null;
  errorCode: string | null;
  errorDetail: string | null;
}

const CLEAN: VerifyAccountResult = {
  status: "DONE",
  errorClass: null,
  errorCode: null,
  errorDetail: null,
};

export async function verifyAccount(
  tx: Database,
  run: BillRun,
  billingAccountId: string,
): Promise<VerifyAccountResult> {
  const bill = await customerBillRepository.findUnpostedTotalForVerification(
    tx,
    run.billRunId,
    billingAccountId,
  );

  // No unposted bill (aggregation never ran, or the account was excluded) — the
  // backstop has nothing to check, so the stage completes cleanly.
  if (!bill) return CLEAN;

  if (bill.nonPositive) {
    return {
      status: "DONE",
      errorClass: "SOFT",
      errorCode: "NON_POSITIVE_TOTAL",
      errorDetail: `Bill total ${bill.totalAmount} is not positive for account ${billingAccountId}.`,
    };
  }

  return CLEAN;
}
