// ADJ write-off (ac10-spec §2.1-§2.3, §3.2) — creates an ADJ document + one
// `charge` line (reason `BAD_DEBT_WRITEOFF`, limit 0 — always four-eyes,
// Q20), removing an uncollectable A/R balance to `sys.write_off` (GL 6100,
// Q19). Reduces a BAN's A/R (Q1 — BAN required); `amount` must not exceed
// the BAN's live open A/R balance (§2.1 table, §3.3) — checked inside the
// transaction against the `tx` handle (TOCTOU-safe, same pattern as
// `reverse-deposit.ts`/`refund-deposit.ts`). No `payment_status`
// re-derivation here: `auto_post_limit = 0` means `submitDocument` always
// routes this to `pending_approval`, never posting synchronously in this
// service. Re-derivation happens in `approveDocument` (document-state-machine.ts)
// at approval time for all document types with a BAN.

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
import type { WriteOffInput } from "@/validation/accounts/write-off.schema";

export type { WriteOffInput };

export type WriteOffResult =
  | SubmitDocumentResult
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "BILLING_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "AMOUNT_EXCEEDS_OPEN_RECEIVABLE" };

export async function writeOff(
  input: WriteOffInput,
  actorId: string,
): Promise<WriteOffResult> {
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

  class _SubmitFailed extends Error {
    constructor(public result: WriteOffResult) {
      super("submit-failed");
    }
  }

  return db
    .transaction(async (tx) => {
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
      const openReceivable = balance ?? "0.00";
      if (money.compare(input.amount, openReceivable) > 0) {
        throw new _SubmitFailed({
          ok: false,
          code: "AMOUNT_EXCEEDS_OPEN_RECEIVABLE",
        });
      }

      const doc = await documentRepository.insert(tx, "ADJ", {
        state: "draft",
        refFinancialAccountId: fa.financialAccountId,
        refBillingAccountId: ban.billingAccountId,
        reasonCode: "BAD_DEBT_WRITEOFF",
        currency: fa.currency,
        totalAmount: input.amount,
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
        amount: input.amount,
        pgledgerTransferId: null,
        reversedByLineId: null,
        lastEditedBy: actorId,
      });

      // Always four-eyes (`auto_post_limit = 0`, Q20) — `submitDocument`
      // always routes this to `pending_approval`; a non-creator MANAGER
      // posts it via `approve-document`.
      const submitted = await submitDocument(tx, doc.documentId, actorId);
      if (!submitted.ok) throw new _SubmitFailed(submitted);
      return submitted;
    })
    .catch((e: unknown) => {
      if (e instanceof _SubmitFailed) return e.result;
      throw e;
    });
}
