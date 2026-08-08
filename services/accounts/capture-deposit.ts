// DEP capture (ac08-spec §2.2, §3.2) — creates a DEP document + one
// `capture` line, then submits it (threshold routing decides direct-post vs
// pending_approval, reason `SEC_DEPOSIT`, limit 50,000). Books a received
// security deposit as a held liability into `fa.{FIN}.deposits`.

import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { submitDocument } from "@/services/accounts/document-state-machine";
import type { SubmitDocumentResult } from "@/services/accounts/document-state-machine";
import type { CaptureDepositInput } from "@/validation/accounts/capture-deposit.schema";

export type { CaptureDepositInput };

export type CaptureDepositResult =
  | SubmitDocumentResult
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" };

export async function captureDeposit(
  input: CaptureDepositInput,
  actorId: string,
): Promise<CaptureDepositResult> {
  const fa = await financialAccountRepository.findById(
    db,
    input.financialAccountId,
  );
  if (!fa) return { ok: false, code: "FINANCIAL_ACCOUNT_NOT_FOUND" };

  class _SubmitFailed extends Error {
    constructor(public result: CaptureDepositResult) {
      super("submit-failed");
    }
  }

  return db
    .transaction(async (tx) => {
      const doc = await documentRepository.insert(tx, "DEP", {
        state: "draft",
        refFinancialAccountId: fa.financialAccountId,
        refBillingAccountId: null,
        reasonCode: "SEC_DEPOSIT",
        currency: fa.currency,
        totalAmount: input.amount,
        paymentMode: input.payment_mode,
        modeRef: input.mode_ref,
        entryDate: input.entryDate,
        referenceInfo: input.referenceInfo,
        eventAt: input.eventAt,
        postedAt: null,
        reversalOf: null,
        createdBy: actorId,
        approvedBy: null,
        metadata: null,
        lastEditedBy: actorId,
      });

      await documentLineRepository.insert(tx, {
        refDocumentId: doc.documentId,
        lineNo: 1,
        lineKind: "capture",
        refBillingAccountId: null,
        refSettledDocumentId: null,
        amount: input.amount,
        pgledgerTransferId: null,
        reversedByLineId: null,
        lastEditedBy: actorId,
      });

      const result = await submitDocument(tx, doc.documentId, actorId);
      if (!result.ok) throw new _SubmitFailed(result);
      return result;
    })
    .catch((e: unknown) => {
      if (e instanceof _SubmitFailed) return e.result;
      throw e;
    });
}
