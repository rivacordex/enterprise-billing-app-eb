import { db } from "@/db/client";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import type { RejectedPendingRow } from "@/types/billing";

// bm17-spec §Implementation §5. The Errors tab's "Rejected — pending
// reprocess" read: accounts currently carrying the `REJECTED_PENDING_
// REPROCESS` marker on their current-attempt latest stage row. Derived live,
// no cache read (architecture Inv. #12) — a rerun's attempt bump clears an
// account from this list implicitly (Phase-2 review fold T6).
export async function listRejectedPending(
  billRunId: string,
): Promise<RejectedPendingRow[]> {
  return billRunAccountStageRepository.listRejectedPendingForRun(db, billRunId);
}
