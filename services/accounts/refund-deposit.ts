// DEP refund (ac08-spec §2.2, §3.2) — creates a DEP document + one `refund`
// line, paying the refundable balance out of the bank (reason `DEP_REFUND`,
// limit 0 — always four-eyes, Q20). Pays out of `fa.{FIN}.unapplied_cash`
// (V14's canonical reverse-then-refund path, §2.2 note — a direct refund of
// a still-held deposit is out of scope for this unit).

import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { getUnappliedCashAvailable } from "@/services/accounts/refund-payment";
import * as money from "@/services/accounts/money";
import { submitDocument } from "@/services/accounts/document-state-machine";
import type { SubmitDocumentResult } from "@/services/accounts/document-state-machine";
import type { RefundDepositInput } from "@/validation/accounts/refund-deposit.schema";

export type { RefundDepositInput };

export type RefundDepositResult =
  | SubmitDocumentResult
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "AMOUNT_EXCEEDS_REFUNDABLE" };

export async function refundDeposit(
  input: RefundDepositInput,
  actorId: string,
): Promise<RefundDepositResult> {
  const fa = await financialAccountRepository.findById(
    db,
    input.financialAccountId,
  );
  if (!fa) return { ok: false, code: "FINANCIAL_ACCOUNT_NOT_FOUND" };

  // §3.3 — live-read balance check (Module Inv. #2), reusing the same
  // `fa.{FIN}.unapplied_cash` read `refund-payment.ts` uses for the payment
  // refund workbench's overpayment payout.
  const refundable = await getUnappliedCashAvailable(fa.financialAccountId);
  if (money.compare(input.amount, refundable) > 0) {
    return { ok: false, code: "AMOUNT_EXCEEDS_REFUNDABLE" };
  }

  return db.transaction(async (tx) => {
    const doc = await documentRepository.insert(tx, "DEP", {
      state: "draft",
      refFinancialAccountId: fa.financialAccountId,
      refBillingAccountId: null,
      reasonCode: "DEP_REFUND",
      currency: fa.currency,
      totalAmount: input.amount,
      paymentMode: input.paymentMode,
      modeRef: input.modeRef,
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
      lineKind: "refund",
      refBillingAccountId: null,
      refSettledDocumentId: null,
      amount: input.amount,
      pgledgerTransferId: null,
      reversedByLineId: null,
      lastEditedBy: actorId,
    });

    // Always four-eyes (`auto_post_limit = 0`, Q20) — `submitDocument`
    // always routes this to `pending_approval`.
    return submitDocument(tx, doc.documentId, actorId);
  });
}
