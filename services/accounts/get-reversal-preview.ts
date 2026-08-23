// Read side for the Reversals workbench (ac11-spec §2.5) — given a posted
// document ID (validated against the selected FA), loads its lines and each
// line's pgledger transfer to build the preview of opposite legs. The
// client-side preview drawer renders these before the operator confirms.

import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { checkDocumentReversible } from "@/services/accounts/document-reversibility";

export type ReversalPreviewLine = {
  documentLineId: string;
  lineNo: number;
  lineKind: string;
  amount: string;
  // The opposite leg that would post if this line is reversed.
  reversalFromAccountId: string;
  reversalFromAccountName: string;
  reversalToAccountId: string;
  reversalToAccountName: string;
  isAllocation: boolean;
  alreadyReversed: boolean;
};

export type ReversalPreview = {
  documentId: string;
  docType: string;
  reasonCode: string;
  totalAmount: string;
  currency: string;
  state: string;
  // ISO string (not Date) so the value survives Next.js server-action
  // serialization — the panel passes it straight to reverseDocumentAction and
  // z.coerce.date() in the schema handles the conversion.
  lastModified: string;
  lines: ReversalPreviewLine[];
};

export type GetReversalPreviewResult =
  | { ok: true; value: ReversalPreview }
  | { ok: false; code: "DOCUMENT_NOT_FOUND" }
  | { ok: false; code: "WRONG_FINANCIAL_ACCOUNT" }
  | { ok: false; code: "DOC_STATE_INVALID" }
  | { ok: false; code: "INV_NOT_REVERSIBLE" }
  | { ok: false; code: "TRANSFER_NOT_FOUND" };

export async function getReversalPreview(
  documentId: string,
  financialAccountId: string,
): Promise<GetReversalPreviewResult> {
  const doc = await documentRepository.findById(db, documentId);
  if (!doc) return { ok: false, code: "DOCUMENT_NOT_FOUND" };
  if (doc.refFinancialAccountId !== financialAccountId) {
    return { ok: false, code: "WRONG_FINANCIAL_ACCOUNT" };
  }
  if (doc.state !== "posted") {
    return { ok: false, code: "DOC_STATE_INVALID" };
  }
  const notReversible = checkDocumentReversible(doc);
  if (notReversible) return notReversible;

  const rawLines = await documentLineRepository.findByDocumentId(
    db,
    documentId,
  );

  const previewLines: ReversalPreviewLine[] = [];
  for (const line of rawLines) {
    const alreadyReversed = line.reversedByLineId !== null;

    let reversalFromAccountId = "";
    let reversalFromAccountName = "";
    let reversalToAccountId = "";
    let reversalToAccountName = "";

    if (!line.pgledgerTransferId) {
      return { ok: false, code: "TRANSFER_NOT_FOUND" };
    }
    const transfer = await ledgerRepository.findTransferById(
      db,
      line.pgledgerTransferId,
    );
    if (!transfer) {
      return { ok: false, code: "TRANSFER_NOT_FOUND" };
    }
    // Opposite leg: swap from ↔ to (ac11-spec §2.1).
    reversalFromAccountId = transfer.toAccountId;
    reversalFromAccountName = transfer.toAccountName;
    reversalToAccountId = transfer.fromAccountId;
    reversalToAccountName = transfer.fromAccountName;

    previewLines.push({
      documentLineId: line.documentLineId,
      lineNo: line.lineNo,
      lineKind: line.lineKind,
      amount: line.amount,
      reversalFromAccountId,
      reversalFromAccountName,
      reversalToAccountId,
      reversalToAccountName,
      isAllocation: line.lineKind === "allocation",
      alreadyReversed,
    });
  }

  return {
    ok: true,
    value: {
      documentId: doc.documentId,
      docType: doc.docType,
      reasonCode: doc.reasonCode,
      totalAmount: doc.totalAmount,
      currency: doc.currency,
      state: doc.state,
      lastModified: doc.lastModified.toISOString(),
      lines: previewLines,
    },
  };
}
