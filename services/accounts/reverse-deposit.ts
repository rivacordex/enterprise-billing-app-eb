// DEP reverse-to-account (ac08-spec §2.2, §3.2) — creates a DEP document +
// one `release` line, releasing the held deposit into ordinary unapplied
// cash (reason `DEP_REVERSE`, limit 0 — always four-eyes, Q20). Internal
// only: no `sys.cash` leg, no bank movement.

import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import * as money from "@/services/accounts/money";
import { submitDocument } from "@/services/accounts/document-state-machine";
import type { SubmitDocumentResult } from "@/services/accounts/document-state-machine";
import type { ReverseDepositInput } from "@/validation/accounts/reverse-deposit.schema";

export type { ReverseDepositInput };

export type ReverseDepositResult =
  | SubmitDocumentResult
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "AMOUNT_EXCEEDS_HELD_DEPOSIT" };

// §2.1/§3.3 — live-read balance check (Module Inv. #2): the FA's held
// deposit is `0 - balance` on `fa.{FIN}.deposits` (credit-normal, negative =
// held — same convention as `refund-payment.ts`'s `getUnappliedCashAvailable`).
export async function getDepositHeldAmount(
  financialAccountId: string,
): Promise<string> {
  const bindings = await ledgerBindingRepository.findByOwner(
    db,
    "financial_account",
    financialAccountId,
  );
  const deposits = bindings.find((b) => b.ledgerRole === "deposits");
  if (!deposits) {
    throw new Error(`deposits binding not found for FA ${financialAccountId}`);
  }
  const balance = await ledgerRepository.balanceByLedgerAccountId(
    db,
    deposits.pgledgerAccountId,
  );
  return money.subtract("0.00", balance ?? "0.00");
}

export async function reverseDeposit(
  input: ReverseDepositInput,
  actorId: string,
): Promise<ReverseDepositResult> {
  const fa = await financialAccountRepository.findById(
    db,
    input.financialAccountId,
  );
  if (!fa) return { ok: false, code: "FINANCIAL_ACCOUNT_NOT_FOUND" };

  class _SubmitFailed extends Error {
    constructor(public result: ReverseDepositResult) {
      super("submit-failed");
    }
  }

  return db
    .transaction(async (tx) => {
      const bindings = await ledgerBindingRepository.findByOwner(
        tx,
        "financial_account",
        fa.financialAccountId,
      );
      const deposits = bindings.find((b) => b.ledgerRole === "deposits");
      if (!deposits) {
        throw new Error(
          `deposits binding not found for FA ${fa.financialAccountId}`,
        );
      }
      const balance = await ledgerRepository.balanceByLedgerAccountId(
        tx,
        deposits.pgledgerAccountId,
      );
      const held = money.subtract("0.00", balance ?? "0.00");
      if (money.compare(input.amount, held) > 0) {
        throw new _SubmitFailed({
          ok: false,
          code: "AMOUNT_EXCEEDS_HELD_DEPOSIT",
        });
      }

      const doc = await documentRepository.insert(tx, "DEP", {
        state: "draft",
        refFinancialAccountId: fa.financialAccountId,
        refBillingAccountId: null,
        reasonCode: "DEP_REVERSE",
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
        lineKind: "release",
        refBillingAccountId: null,
        refSettledDocumentId: null,
        amount: input.amount,
        pgledgerTransferId: null,
        reversedByLineId: null,
        lastEditedBy: actorId,
      });

      // Always four-eyes (`auto_post_limit = 0`, Q20) — `submitDocument`
      // always routes this to `pending_approval`.
      const result = await submitDocument(tx, doc.documentId, actorId);
      if (!result.ok) throw new _SubmitFailed(result);
      return result;
    })
    .catch((e: unknown) => {
      if (e instanceof _SubmitFailed) return e.result;
      throw e;
    });
}
