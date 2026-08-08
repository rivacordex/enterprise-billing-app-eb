// Line-level reversal (ac11-spec §2.2, §3.2) — reverses only the selected
// document lines (Q5 headline case: reverse a PAY's allocation line returning
// funds to unapplied_cash without touching the bank capture). Each selected
// line must be unreversed; a line already carrying `reversed_by_line_id` is
// rejected with `ALREADY_REVERSED`. The original doc flips to `reversed` only
// when ALL its lines (including any previously reversed) are now covered.

import { db } from "@/db/client";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import * as money from "@/services/accounts/money";
import { submitDocument } from "@/services/accounts/document-state-machine";
import type { SubmitDocumentResult } from "@/services/accounts/document-state-machine";
import type { DocType, LineKind } from "@/types/accounts";
import type { ReverseDocumentInput } from "@/validation/accounts/reverse-document.schema";

export type { ReverseDocumentInput };

export type ReverseLineResult =
  | SubmitDocumentResult
  | { ok: false; code: "DOCUMENT_NOT_FOUND" }
  | { ok: false; code: "WRONG_FINANCIAL_ACCOUNT" }
  | { ok: false; code: "DOC_STATE_INVALID" }
  | { ok: false; code: "LINE_NOT_FOUND" }
  | { ok: false; code: "ALREADY_REVERSED" }
  | { ok: false; code: "BILLING_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "CONFLICT" };

export async function reverseLine(
  input: ReverseDocumentInput & { selectedLineIds: string[] },
  actorId: string,
): Promise<ReverseLineResult> {
  const doc = await documentRepository.findById(db, input.originalDocumentId);
  if (!doc) return { ok: false, code: "DOCUMENT_NOT_FOUND" };
  if (doc.refFinancialAccountId !== input.financialAccountId) {
    return { ok: false, code: "WRONG_FINANCIAL_ACCOUNT" };
  }
  if (doc.state !== "posted") return { ok: false, code: "DOC_STATE_INVALID" };

  if (input.selectedLineIds.length === 0) {
    return { ok: false, code: "LINE_NOT_FOUND" };
  }

  // Resolve each selected line and validate ownership + reversibility.
  const selectedLines: Array<
    NonNullable<Awaited<ReturnType<typeof documentLineRepository.findById>>>
  > = [];
  const seen = new Set<string>();
  for (const lineId of input.selectedLineIds) {
    if (seen.has(lineId)) return { ok: false, code: "LINE_NOT_FOUND" };
    seen.add(lineId);

    const line = await documentLineRepository.findById(db, lineId);
    if (!line || line.refDocumentId !== doc.documentId) {
      return { ok: false, code: "LINE_NOT_FOUND" };
    }
    if (line.reversedByLineId) return { ok: false, code: "ALREADY_REVERSED" };
    if (!line.pgledgerTransferId) {
      throw new Error(
        `Posted line ${line.documentLineId} has no pgledger_transfer_id`,
      );
    }
    selectedLines.push(line);
  }

  // Validate BAN ownership for allocation lines (Q1 — the allocation reversal
  // restores A/R on the BAN, which must belong to the FA).
  for (const line of selectedLines) {
    if (line.lineKind === "allocation" && line.refBillingAccountId) {
      const ban = await billingAccountRepository.findById(
        db,
        line.refBillingAccountId,
      );
      if (!ban || ban.refFinancialAccountId !== doc.refFinancialAccountId) {
        return { ok: false, code: "BILLING_ACCOUNT_NOT_FOUND" };
      }
    }
  }

  // Compute opposite legs from original transfers (append-only ledger — safe
  // to read outside the transaction).
  type StoredLeg = {
    fromAccountId: string;
    toAccountId: string;
    amount: string;
  };
  const legs: StoredLeg[] = [];
  for (const line of selectedLines) {
    const transfer = await ledgerRepository.findTransferById(
      db,
      line.pgledgerTransferId!,
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

  const totalAmount = money.sum(...selectedLines.map((l) => l.amount));

  class _Failed extends Error {
    constructor(public result: ReverseLineResult) {
      super("failed");
    }
  }

  return db
    .transaction(async (tx) => {
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

      // Single read for both TOCTOU validation and the post-doc-state check.
      // READ COMMITTED: sees committed data at statement time, so concurrent
      // committed stamps from other transactions are visible here.
      const txAllLines = await documentLineRepository.findByDocumentId(
        tx,
        input.originalDocumentId,
      );
      const txLineById = new Map(txAllLines.map((l) => [l.documentLineId, l]));
      for (const line of selectedLines) {
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

      const reversalLineIds: string[] = [];
      for (let i = 0; i < selectedLines.length; i++) {
        const orig = selectedLines[i]!;
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

      // Conditional stamp (WHERE reversed_by_line_id IS NULL): if a concurrent
      // reversal claimed a line between the TOCTOU check and this UPDATE, the
      // stamp returns false → ALREADY_REVERSED. Own uncommitted writes are
      // visible to subsequent reads in the same transaction (PostgreSQL).
      for (let i = 0; i < selectedLines.length; i++) {
        const stamped = await documentLineRepository.setReversedByLineId(
          tx,
          selectedLines[i]!.documentLineId,
          reversalLineIds[i]!,
        );
        if (!stamped)
          throw new _Failed({ ok: false, code: "ALREADY_REVERSED" });
      }

      // Post-stamp re-read: own writes + any concurrent committed stamps are
      // visible here (READ COMMITTED). The last transaction to complete sees
      // all stamps and is the one that flips the doc to 'reversed', closing
      // the race where two transactions each reverse different lines and both
      // see the other's pre-stamp snapshot.
      const finalLines = await documentLineRepository.findByDocumentId(
        tx,
        input.originalDocumentId,
      );
      const allNowReversed = finalLines.every(
        (l) => l.reversedByLineId !== null,
      );
      if (allNowReversed) {
        const updated = await documentRepository.compareAndUpdateState(
          tx,
          doc.documentId,
          txDoc.lastModified,
          { state: "reversed", lastEditedBy: actorId },
        );
        if (!updated) throw new _Failed({ ok: false, code: "CONFLICT" });
      }

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
