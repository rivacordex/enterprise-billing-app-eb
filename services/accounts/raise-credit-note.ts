// CRN — raise-credit-note (ac09-spec §2.1-§2.2, §3.2) — creates a CRN
// document + one `charge` line (reason `GOODWILL_CREDIT`, limit 1,000,
// above which `submitDocument` routes to `pending_approval`, Q20). Reduces a
// BAN's A/R (Q1 — BAN required), steered to `sys.revenue_adj` (Q19).
// `payment_status` re-derives after posting (§2.5), same live-read pattern
// as `allocate-payment.ts`/`raise-debit-note.ts`.

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
import type { RaiseCreditNoteInput } from "@/validation/accounts/raise-credit-note.schema";

export type { RaiseCreditNoteInput };

export type RaiseCreditNoteResult =
  | SubmitDocumentResult
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "BILLING_ACCOUNT_NOT_FOUND" };

export async function raiseCreditNote(
  input: RaiseCreditNoteInput,
  actorId: string,
): Promise<RaiseCreditNoteResult> {
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

  return db.transaction(async (tx) => {
    const doc = await documentRepository.insert(tx, "CRN", {
      state: "draft",
      refFinancialAccountId: fa.financialAccountId,
      refBillingAccountId: ban.billingAccountId,
      reasonCode: "GOODWILL_CREDIT",
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
      lineKind: "charge",
      refBillingAccountId: ban.billingAccountId,
      refSettledDocumentId: null,
      amount: input.amount,
      pgledgerTransferId: null,
      reversedByLineId: null,
      lastEditedBy: actorId,
    });

    const submitted = await submitDocument(tx, doc.documentId, actorId);
    if (!submitted.ok || submitted.value.state !== "posted") return submitted;

    // §2.5 — live read inside the same transaction (Module Inv. #2), same
    // convention as `allocate-payment.ts`/`raise-debit-note.ts`.
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
