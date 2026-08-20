import type { ErrorClass, StageStatus } from "@/types/billing";

// bm05-spec §Design/§Implementation §3. Collection/Claim (stage 3) — a v1
// no-op: there is no `rating.udr_rated` table to claim from, so there is no
// rating grant, no claim repository, and no cross-schema write of any kind
// (architecture Inv. #1/#2). The `collection` signal simply records
// completion, mirroring how `validate-account.ts` computes the Validation
// stage's outcome rather than trusting the caller's body
// (`handle-stage-signal.ts`).
//
// deferred: rating claim + grant land with the rating engine (architecture
// Inv. #2) — when `rating.udr_rated` exists, this function is replaced by a
// real claim (`UPDATE rating.udr_rated SET ref_bill_run_id = ..., attempt =
// ... WHERE ...`) issued from the single sanctioned
// `db/repositories/billing/rating-claim.ts` writer.

export interface CollectClaimResult {
  status: Extract<StageStatus, "DONE">;
  errorClass: ErrorClass | null;
  errorCode: string | null;
  errorDetail: string | null;
}

export function collectClaim(): CollectClaimResult {
  return {
    status: "DONE",
    errorClass: null,
    errorCode: null,
    errorDetail: null,
  };
}
