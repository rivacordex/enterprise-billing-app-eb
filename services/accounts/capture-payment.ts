// PAY capture (ac07-spec §2.4, §3.4) — creates a PAY document + one `capture`
// line, then submits it (threshold routing decides direct-post vs
// pending_approval). Books received money into `fa.{FIN}.unapplied_cash`;
// advance payment is exactly this, with no allocation line (Q15).

import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { submitDocument } from "@/services/accounts/document-state-machine";
import type { SubmitDocumentResult } from "@/services/accounts/document-state-machine";
import type { CapturePaymentInput } from "@/validation/accounts/capture-payment.schema";

export type { CapturePaymentInput };

export type CapturePaymentResult =
  | SubmitDocumentResult
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" };

export async function capturePayment(
  input: CapturePaymentInput,
  actorId: string,
): Promise<CapturePaymentResult> {
  const fa = await financialAccountRepository.findById(
    db,
    input.financialAccountId,
  );
  if (!fa) return { ok: false, code: "FINANCIAL_ACCOUNT_NOT_FOUND" };

  return db.transaction(async (tx) => {
    const doc = await documentRepository.insert(tx, "PAY", {
      state: "draft",
      refFinancialAccountId: fa.financialAccountId,
      refBillingAccountId: null,
      reasonCode: input.reasonCode,
      currency: fa.currency,
      totalAmount: input.amount,
      paymentMode: input.payment_mode,
      modeRef: input.mode_ref,
      referenceDate: input.referenceDate,
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

    return submitDocument(tx, doc.documentId, actorId);
  });
}
