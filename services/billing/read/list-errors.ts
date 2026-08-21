import { db } from "@/db/client";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import type { ErrorRow } from "@/types/billing";

// bm07-spec §Design/§Implementation §2. The Errors tab's read — the run's
// blocking `PROCESSING_FAILED` accounts, each joined to its latest-attempt
// `HARD` stage row (the stage/code/detail that blocked it). Derived live, no
// cache read. Zero rows is a positive empty state (the tab renders it, not a
// blank panel).
export async function listErrors(billRunId: string): Promise<ErrorRow[]> {
  const rows = await billRunAccountRepository.listErrorsForRun(db, billRunId);

  return rows.map((row) => ({
    billingAccountId: row.billingAccountId,
    accountName: row.accountName,
    stage: row.stage,
    errorClass: row.errorClass,
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
  }));
}
