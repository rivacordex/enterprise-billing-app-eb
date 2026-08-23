// Document-level reversal (ac11-spec §2.2, §3.2) — reverses every unreversed
// posted line of the original document, creating a new reversal doc with
// opposite legs (from ↔ to swapped per ac11-spec §2.1). The original doc
// always flips to `reversed` after this service runs (all lines are covered
// by either a prior or this reversal). Approval weight matches the original's
// reason code (§2.4). `reversed_by_line_id` is stamped on original lines in
// the same transaction, before `submitDocument`, matching `refundPayment`'s
// allocation-line stamping precedent.

import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import * as money from "@/services/accounts/money";
import { checkDocumentReversible } from "@/services/accounts/document-reversibility";
import { submitDocument } from "@/services/accounts/document-state-machine";
import type { SubmitDocumentResult } from "@/services/accounts/document-state-machine";
import type { DocType, LineKind } from "@/types/accounts";
import type { ReverseDocumentInput } from "@/validation/accounts/reverse-document.schema";

export type { ReverseDocumentInput };

export type ReverseDocumentResult =
  | SubmitDocumentResult
  | { ok: false; code: "DOCUMENT_NOT_FOUND" }
  | { ok: false; code: "WRONG_FINANCIAL_ACCOUNT" }
  | { ok: false; code: "DOC_STATE_INVALID" }
  | { ok: false; code: "ALREADY_REVERSED" }
  | { ok: false; code: "INV_NOT_REVERSIBLE" }
  | { ok: false; code: "CONFLICT" };

export async function reverseDocument(
  input: ReverseDocumentInput,
  actorId: string,
): Promise<ReverseDocumentResult> {
  const doc = await documentRepository.findById(db, input.originalDocumentId);
  if (!doc) return { ok: false, code: "DOCUMENT_NOT_FOUND" };
  if (doc.refFinancialAccountId !== input.financialAccountId) {
    return { ok: false, code: "WRONG_FINANCIAL_ACCOUNT" };
  }
  if (doc.state !== "posted") return { ok: false, code: "DOC_STATE_INVALID" };
  const notReversible = checkDocumentReversible(doc);
  if (notReversible) return notReversible;

  const allLines = await documentLineRepository.findByDocumentId(
    db,
    input.originalDocumentId,
  );
  const unreversedLines = allLines.filter((l) => !l.reversedByLineId);
  if (unreversedLines.length === 0)
    return { ok: false, code: "ALREADY_REVERSED" };

  // Compute opposite legs from original transfers. pgledger is append-only so
  // transfer data is immutable — reading outside the transaction is safe.
  type StoredLeg = {
    fromAccountId: string;
    toAccountId: string;
    amount: string;
  };
  const legs: StoredLeg[] = [];
  for (const line of unreversedLines) {
    if (!line.pgledgerTransferId) {
      throw new Error(
        `Posted line ${line.documentLineId} has no pgledger_transfer_id`,
      );
    }
    const transfer = await ledgerRepository.findTransferById(
      db,
      line.pgledgerTransferId,
    );
    if (!transfer) {
      throw new Error(
        `Transfer ${line.pgledgerTransferId} not found for line ${line.documentLineId}`,
      );
    }
    legs.push({
      fromAccountId: transfer.toAccountId,
      toAccountId: transfer.fromAccountId,
      amount: line.amount,
    });
  }

  const totalAmount = money.sum(...unreversedLines.map((l) => l.amount));

  class _Failed extends Error {
    constructor(public result: ReverseDocumentResult) {
      super("failed");
    }
  }

  return db
    .transaction(async (tx) => {
      // Re-read inside the transaction for CAS on the original doc.
      const txDoc = await documentRepository.findById(
        tx,
        input.originalDocumentId,
      );
      if (!txDoc || txDoc.state !== "posted") {
        throw new _Failed({ ok: false, code: "DOC_STATE_INVALID" });
      }
      if (txDoc.lastModified.getTime() !== input.lastModified.getTime()) {
        throw new _Failed({ ok: false, code: "CONFLICT" });
      }

      // Re-validate lines inside the transaction to close the TOCTOU window
      // (lines were fetched before the transaction opened; a concurrent
      // reversal could have stamped reversedByLineId between then and now).
      const txAllLines = await documentLineRepository.findByDocumentId(
        tx,
        input.originalDocumentId,
      );
      const txLineById = new Map(txAllLines.map((l) => [l.documentLineId, l]));
      for (const line of unreversedLines) {
        const txLine = txLineById.get(line.documentLineId);
        if (!txLine || txLine.reversedByLineId !== null) {
          throw new _Failed({ ok: false, code: "ALREADY_REVERSED" });
        }
      }

      const reversalDoc = await documentRepository.insert(
        tx,
        doc.docType as DocType,
        {
          state: "draft",
          refFinancialAccountId: doc.refFinancialAccountId,
          refBillingAccountId: doc.refBillingAccountId,
          reasonCode: doc.reasonCode,
          currency: doc.currency,
          totalAmount,
          paymentMode: null,
          modeRef: null,
          entryDate: input.entryDate,
          referenceInfo: input.referenceInfo,
          eventAt: input.eventAt,
          postedAt: null,
          reversalOf: doc.documentId,
          createdBy: actorId,
          approvedBy: null,
          metadata: {
            reversalLegs: legs,
            reversalComment: input.reversalComment,
            reverses: doc.documentId,
          },
          lastEditedBy: actorId,
        },
      );

      // Create reversal lines in the same lineNo order as the opposite legs.
      const reversalLineIds: string[] = [];
      for (let i = 0; i < unreversedLines.length; i++) {
        const orig = unreversedLines[i]!;
        const reversalLine = await documentLineRepository.insert(tx, {
          refDocumentId: reversalDoc.documentId,
          lineNo: i + 1,
          lineKind: orig.lineKind as LineKind,
          refBillingAccountId: orig.refBillingAccountId,
          refSettledDocumentId: null,
          amount: orig.amount,
          pgledgerTransferId: null,
          reversedByLineId: null,
          lastEditedBy: actorId,
        });
        reversalLineIds.push(reversalLine.documentLineId);
      }

      // Stamp reversedByLineId on original lines (same-transaction stamping,
      // matching refundPayment's allocation-line precedent — the stamp is a
      // durable lock even if the reversal doc ends up in pending_approval).
      // The conditional WHERE IS NULL is the atomic guard: if a concurrent
      // reversal claimed the line between our TOCTOU check and this UPDATE,
      // the stamp returns false and we surface ALREADY_REVERSED.
      for (let i = 0; i < unreversedLines.length; i++) {
        const stamped = await documentLineRepository.setReversedByLineId(
          tx,
          unreversedLines[i]!.documentLineId,
          reversalLineIds[i]!,
        );
        if (!stamped)
          throw new _Failed({ ok: false, code: "ALREADY_REVERSED" });
      }

      // Document-level reversal covers all unreversed lines → original is
      // fully reversed after this operation (previously-reversed lines, if
      // any, already have reversedByLineId set from earlier reversals).
      const updated = await documentRepository.compareAndUpdateState(
        tx,
        doc.documentId,
        txDoc.lastModified,
        { state: "reversed", lastEditedBy: actorId },
      );
      if (!updated) throw new _Failed({ ok: false, code: "CONFLICT" });

      const submitted = await submitDocument(
        tx,
        reversalDoc.documentId,
        actorId,
      );
      if (!submitted.ok) throw new _Failed(submitted);
      return submitted;
    })
    .catch((e: unknown) => {
      if (e instanceof _Failed) return e.result;
      throw e;
    });
}
