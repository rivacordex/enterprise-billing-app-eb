// ac21-spec §3.1 — focused read service: document + lines + ledger-transfer
// rows for the document detail drawer. SELECTs only (inv. #15). No write, no
// transaction, no pgledger base-table access (inv. #4 — views/functions only
// via ledgerRepository).
//
// Security: re-checks FA ownership before returning any data so a tampered
// ?doc param cannot expose another customer's document (§2.6).

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { document as documentTable } from "@/db/schema/billing/documents";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import type { TransactionDocumentDetail } from "@/types/accounts";

export type GetTransactionDocumentDetailResult =
  | { ok: true; detail: TransactionDocumentDetail }
  | { ok: false; code: "DOCUMENT_NOT_FOUND" }
  | { ok: false; code: "WRONG_FINANCIAL_ACCOUNT" };

export async function getTransactionDocumentDetail(
  documentId: string,
  financialAccountId: string,
): Promise<GetTransactionDocumentDetailResult> {
  const doc = await documentRepository.findById(db, documentId);
  if (!doc) return { ok: false, code: "DOCUMENT_NOT_FOUND" };
  if (doc.refFinancialAccountId !== financialAccountId) {
    return { ok: false, code: "WRONG_FINANCIAL_ACCOUNT" };
  }

  const [lines, reversedByRows] = await Promise.all([
    documentLineRepository.findByDocumentId(db, documentId),
    // Reverse-lookup: find any document whose reversalOf points to this doc.
    // Direct Drizzle query — no formal repo method needed for a one-off
    // display-side cross-link (spec §2: "no new repository method").
    db
      .select({ documentId: documentTable.documentId })
      .from(documentTable)
      .where(eq(documentTable.reversalOf, documentId))
      .limit(1),
  ]);

  const reversedByDocumentId = reversedByRows[0]?.documentId ?? null;

  // Collect non-null pgledgerTransferIds for the batch fetch.
  const transferIds = lines
    .map((l) => l.pgledgerTransferId)
    .filter((id): id is string => id !== null);

  const transfersMap = await ledgerRepository.findTransfersByIds(
    db,
    transferIds,
  );

  const partiallyReversed =
    doc.state === "posted" &&
    lines.some((l) => l.reversedByLineId !== null) &&
    lines.some((l) => l.reversedByLineId === null);

  return {
    ok: true,
    detail: {
      document: doc,
      lines: lines.map((line) => ({
        line,
        transfer: line.pgledgerTransferId
          ? (transfersMap.get(line.pgledgerTransferId) ?? null)
          : null,
      })),
      partiallyReversed,
      reversedByDocumentId,
    },
  };
}
