import type { Database } from "@/db/client";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { resolveTerm } from "@/services/accounts/term-resolution";
import type { ErrorClass, StageStatus } from "@/types/billing";

// bm04-spec §Design/§Implementation §8 (§31). The Validation stage's
// readiness gate — the ONE stage in bm04 whose outcome the app computes
// itself, rather than recording whatever the caller's signal says
// (collection/aggregation/taxation/verification stay record-and-advance
// pass-through, `handle-stage-signal.ts`). Pure read, no writes: a
// resolvable billing profile means a non-null currency, a resolvable bill
// cycle, and resolvable payment terms. The claimable-records / zero-charge
// check is deferred with the rating engine (no `rating` table in v1).

export interface ValidateAccountResult {
  status: Extract<StageStatus, "DONE" | "FAILED">;
  errorClass: ErrorClass | null;
  errorCode: string | null;
  errorDetail: string | null;
}

const UNRESOLVABLE_PROFILE: (detail: string) => ValidateAccountResult = (
  detail,
) => ({
  status: "FAILED",
  errorClass: "HARD",
  errorCode: "UNRESOLVABLE_PROFILE",
  errorDetail: detail,
});

export async function validateAccount(
  tx: Database,
  billingAccountId: string,
): Promise<ValidateAccountResult> {
  const account = await billingAccountRepository.findById(tx, billingAccountId);
  if (!account || !account.currency) {
    return UNRESOLVABLE_PROFILE(
      `Billing account ${billingAccountId} could not be resolved, or has no currency.`,
    );
  }

  const cycle = await billCycleRepository.findById(tx, account.refBillCycleId);
  if (!cycle) {
    return UNRESOLVABLE_PROFILE(
      `Bill cycle ${account.refBillCycleId} could not be resolved for account ${billingAccountId}.`,
    );
  }

  const term = resolveTerm(
    account.paymentDueDaysOverride ?? null,
    cycle.paymentDueDays,
  );
  if (!Number.isFinite(term) || term <= 0) {
    return UNRESOLVABLE_PROFILE(
      `Payment terms could not be resolved for account ${billingAccountId}.`,
    );
  }

  return {
    status: "DONE",
    errorClass: null,
    errorCode: null,
    errorDetail: null,
  };
}
