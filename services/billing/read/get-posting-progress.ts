import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import type {
  PostingAccountStatus,
  PostingProgress,
  PostingProgressRow,
  RunStatus,
} from "@/types/billing";

// bm11-spec §Visual. The `PostingProgressView` read model: one row per
// postable account, its DERIVED display status (never a stored column —
// same idiom as `StallBanner`'s `StallState`), and the running "{n}/{N}
// posted" count. `PERIOD_CLOSED` and `failed` are both `PROCESSED` accounts
// carrying an `errorCode` (parked, Design "PERIOD_CLOSED handling") —
// distinguished only for display; both are retry-eligible the same way.

function deriveStatus(row: {
  status: string;
  errorCode: string | null;
}): PostingAccountStatus {
  if (row.status === "INVOICED") return "invoiced";
  if (row.errorCode === "PERIOD_CLOSED") return "PERIOD_CLOSED";
  if (row.errorCode) return "failed";
  return "pending";
}

export async function getPostingProgress(
  billRunId: string,
): Promise<PostingProgress | null> {
  const detail = await billRunRepository.findDetailById(db, billRunId);
  if (!detail) return null;

  const rows = await billRunAccountRepository.listPostingProgressForRun(
    db,
    billRunId,
  );
  const mapped: PostingProgressRow[] = rows.map((r) => ({
    billingAccountId: r.billingAccountId,
    accountName: r.accountName,
    status: deriveStatus(r),
    invoiceId: r.invoiceId,
    errorDetail: r.errorDetail,
  }));

  return {
    billRunId,
    runStatus: detail.status as RunStatus,
    rows: mapped,
    postedCount: mapped.filter((r) => r.status === "invoiced").length,
    totalCount: mapped.length,
  };
}
