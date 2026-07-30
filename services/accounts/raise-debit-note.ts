// DBN — raise-debit-note (ac09-spec §2.1-§2.3, §3.2) — creates a DBN
// document + one `charge` line (net, reason `MANUAL_CHARGE`, limit 10,000,
// the phase's only charge vehicle — Q21) and, when tax is present, a second
// fixed-tax `release` line (§2.3 — the tax leg's counter-account is fixed to
// `sys.tax_payable` regardless of nature, so it can't share the principal
// line's `charge` key; see `leg-templates.ts`'s comment on this reuse).
// Raises a BAN's A/R (Q1 — BAN required); `payment_status` re-derives after
// posting (§2.5), same live-read pattern as `allocate-payment.ts`.

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
import type { RaiseDebitNoteInput } from "@/validation/accounts/raise-debit-note.schema";

export type { RaiseDebitNoteInput };

export type RaiseDebitNoteResult =
  | SubmitDocumentResult
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "BILLING_ACCOUNT_NOT_FOUND" };

export async function raiseDebitNote(
  input: RaiseDebitNoteInput,
  actorId: string,
): Promise<RaiseDebitNoteResult> {
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

  const hasTax =
    input.taxAmount !== null && money.compare(input.taxAmount, "0.00") > 0;
  const totalAmount = hasTax
    ? money.add(input.netAmount, input.taxAmount!)
    : input.netAmount;

  return db.transaction(async (tx) => {
    const doc = await documentRepository.insert(tx, "DBN", {
      state: "draft",
      refFinancialAccountId: fa.financialAccountId,
      refBillingAccountId: ban.billingAccountId,
      reasonCode: "MANUAL_CHARGE",
      currency: fa.currency,
      totalAmount,
      paymentMode: null,
      modeRef: null,
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
      lineKind: "charge",
      refBillingAccountId: ban.billingAccountId,
      refSettledDocumentId: null,
      amount: input.netAmount,
      pgledgerTransferId: null,
      reversedByLineId: null,
      lastEditedBy: actorId,
    });

    if (hasTax) {
      await documentLineRepository.insert(tx, {
        refDocumentId: doc.documentId,
        lineNo: 2,
        lineKind: "release",
        refBillingAccountId: ban.billingAccountId,
        refSettledDocumentId: null,
        amount: input.taxAmount!,
        pgledgerTransferId: null,
        reversedByLineId: null,
        lastEditedBy: actorId,
      });
    }

    const submitted = await submitDocument(tx, doc.documentId, actorId);
    if (!submitted.ok || submitted.value.state !== "posted") return submitted;

    // §2.5 — live read inside the same transaction (Module Inv. #2), same
    // convention as `allocate-payment.ts`.
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
