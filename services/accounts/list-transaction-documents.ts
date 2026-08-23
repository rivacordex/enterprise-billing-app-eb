// ac20-spec §2.8/§3.2 — read-only document list service for the Transactions
// workbench. Wraps the repository, derives partiallyReversed/reversible/
// actionLabel per §2.3, and returns { rows, total }. No INSERT/UPDATE/DELETE,
// no transaction, no call into post-document.ts or any pgledger function
// (inv. #15). The rev filter is passed through to the repository, which
// implements it post-aggregate in SQL (§3.1 CTE).

import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import type { TransactionDocumentRow } from "@/types/accounts";
import type { TransactionsSearchParams } from "@/validation/accounts/transactions-search-params.schema";

// Human action label: base type + reason code (§2.4, inv. #19 — no sixth
// doc type). DocType alone is ambiguous (PAY covers capture, allocation, refund);
// reasonCode provides the sub-action. Format matches the action-bar entries.
const DOC_TYPE_BASE: Record<string, string> = {
  PAY: "Payment",
  DEP: "Deposit",
  CRN: "Credit Note",
  DBN: "Debit Note",
  ADJ: "Adjustment",
};

function toActionLabel(docType: string, reasonCode: string): string {
  return `${DOC_TYPE_BASE[docType] ?? docType} — ${reasonCode}`;
}

export async function listTransactionDocuments(
  financialAccountId: string,
  billingAccountId: string | null,
  params: Pick<
    TransactionsSearchParams,
    "type" | "status" | "rev" | "q" | "sort" | "page"
  >,
  pageSize: number,
): Promise<{ rows: TransactionDocumentRow[]; total: number }> {
  const { rows, total } = await documentRepository.listForContext(db, {
    financialAccountId,
    billingAccountId,
    docType: params.type,
    state: params.status,
    rev: params.rev,
    q: params.q,
    sort: params.sort,
    page: params.page,
    pageSize,
  });

  const enriched: TransactionDocumentRow[] = rows.map((row) => {
    // §2.3 — mirror of reverse-document.ts eligibility check (inv. #18).
    // `INV` documents are never reversible (bm11 — billing owns their
    // finalization latch; correct via a credit note). The reversal services
    // backstop this with `INV_NOT_REVERSIBLE`; excluding INV here just hides the
    // dead ↺ Reverse control (matching the drawer's `drawerReversible`).
    const partiallyReversed =
      row.state === "posted" &&
      row.unreversedLineCount > 0 &&
      row.unreversedLineCount < row.totalLineCount;
    const reversible =
      row.state === "posted" &&
      row.docType !== "INV" &&
      row.unreversedLineCount > 0;

    return {
      ...row,
      partiallyReversed,
      reversible,
      actionLabel: toActionLabel(row.docType, row.reasonCode),
    };
  });

  return { rows: enriched, total };
}
