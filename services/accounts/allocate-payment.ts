// PAY allocation (ac07-spec §2.4, §3.4, §2.7) — creates a standalone PAY
// document + one `allocation` line applying previously-captured unapplied
// cash against a BAN's receivables (manual only, Q24 — no auto-application).
// Always reason `CUST_PAYMENT` (the only PAY reason whose nature fits an
// application of already-received cash; there is no dedicated "allocate"
// reason code in the ac03 seed set). After posting, flips
// `billing_account.payment_status` from the live receivables balance (V8).

import { db } from "@/db/client";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import * as money from "@/services/accounts/money";
import { submitDocument } from "@/services/accounts/document-state-machine";
import type { SubmitDocumentResult } from "@/services/accounts/document-state-machine";

export type AllocatePaymentInput = {
  financialAccountId: string;
  billingAccountId: string;
  amount: string;
  refSettledDocumentId: string | null;
  eventAt: Date;
  entryDate: Date;
  referenceInfo: string;
};

export type AllocatePaymentResult =
  | SubmitDocumentResult
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "BILLING_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "SETTLED_DOCUMENT_NOT_FOUND" };

export async function allocatePayment(
  input: AllocatePaymentInput,
  actorId: string,
): Promise<AllocatePaymentResult> {
  const fa = await financialAccountRepository.findById(
    db,
    input.financialAccountId,
  );
  if (!fa) return { ok: false, code: "FINANCIAL_ACCOUNT_NOT_FOUND" };

  const ban = await billingAccountRepository.findById(
    db,
    input.billingAccountId,
  );
  if (!ban || ban.refFinancialAccountId !== fa.financialAccountId) {
    return { ok: false, code: "BILLING_ACCOUNT_NOT_FOUND" };
  }

  if (input.refSettledDocumentId) {
    const settled = await documentRepository.findById(
      db,
      input.refSettledDocumentId,
    );
    if (!settled || settled.refBillingAccountId !== ban.billingAccountId) {
      return { ok: false, code: "SETTLED_DOCUMENT_NOT_FOUND" };
    }
  }

  return db.transaction(async (tx) => {
    const doc = await documentRepository.insert(tx, "PAY", {
      state: "draft",
      refFinancialAccountId: fa.financialAccountId,
      refBillingAccountId: ban.billingAccountId,
      reasonCode: "CUST_PAYMENT",
      currency: fa.currency,
      totalAmount: input.amount,
      paymentMode: null,
      modeRef: null,
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
      lineKind: "allocation",
      refBillingAccountId: ban.billingAccountId,
      refSettledDocumentId: input.refSettledDocumentId,
      amount: input.amount,
      pgledgerTransferId: null,
      reversedByLineId: null,
      lastEditedBy: actorId,
    });

    const submitted = await submitDocument(tx, doc.documentId, actorId);
    if (!submitted.ok || submitted.value.state !== "posted") return submitted;

    // §2.7 — live read inside the same transaction (Module Inv. #2), never
    // a value passed in from elsewhere.
    const banBindings = await ledgerBindingRepository.findByOwner(
      tx,
      "billing_account",
      ban.billingAccountId,
    );
    const rec = banBindings.find((b) => b.ledgerRole === "receivables");
    if (!rec) {
      throw new Error(
        `receivables binding not found for BAN ${ban.billingAccountId}`,
      );
    }
    const balance = await ledgerRepository.balanceByLedgerAccountId(
      tx,
      rec.pgledgerAccountId,
    );
    const newStatus =
      money.openReceivable(balance ?? "0.00") > 0n ? "due" : "paid";
    await billingAccountRepository.updatePaymentStatus(
      tx,
      ban.billingAccountId,
      newStatus,
    );

    return submitted;
  });
}
