// ADJ rounding adjustment (ac10-spec §2.1-§2.3, §3.2) — creates an ADJ
// document + one line (reason `ROUNDING_ADJ`, limit 10 — USER posts ≤ 10
// directly, above routes to approval, Q20), clearing a small A/R residue to
// `sys.rounding` (GL 6900, Q19). Reduces or increases a BAN's A/R by a small
// amount (Q1 — BAN required) — the leg *direction* is decided here from the
// live sign of the BAN's receivables balance (§2.2, read inside the
// transaction, TOCTOU-safe, same pattern as `reverse-deposit.ts`): a
// debit/positive residue clears via the `charge` leg shape
// (`ban.receivables → sys.rounding`), a credit/negative residue via the
// `release` leg shape (`sys.rounding → ban.receivables`) — see
// `leg-templates.ts`'s `ADJ_LEG_TEMPLATES` comment. A zero balance has no
// residue to clear, so it's rejected up front. `payment_status` re-derives
// after a direct post (§2.4), same live-read pattern as
// `raise-credit-note.ts`.

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
import type { RoundingAdjustmentInput } from "@/validation/accounts/rounding-adjustment.schema";

export type { RoundingAdjustmentInput };

export type RoundingAdjustmentResult =
  | SubmitDocumentResult
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "BILLING_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "NO_RESIDUE_TO_CLEAR" }
  | { ok: false; code: "AMOUNT_EXCEEDS_OPEN_RECEIVABLE" };

export async function roundingAdjustment(
  input: RoundingAdjustmentInput,
  actorId: string,
): Promise<RoundingAdjustmentResult> {
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
    constructor(public result: RoundingAdjustmentResult) {
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
      const residueSign = money.compare(balance ?? "0.00", "0.00");
      if (residueSign === 0) {
        throw new _SubmitFailed({ ok: false, code: "NO_RESIDUE_TO_CLEAR" });
      }
      // Reject if input.amount exceeds the magnitude of the residue — mirrors
      // the same guard in write-off.ts, but uses abs(balance) since the residue
      // can be either sign (§2.2).
      const balanceSen = money.stringToSen(balance ?? "0.00");
      const absSen = balanceSen < 0n ? -balanceSen : balanceSen;
      if (money.stringToSen(input.amount) > absSen) {
        throw new _SubmitFailed({
          ok: false,
          code: "AMOUNT_EXCEEDS_OPEN_RECEIVABLE",
        });
      }
      // Positive (debit) residue → clear via `charge`
      // (ban.receivables → sys.rounding). Negative (credit) residue →
      // clear via `release`, the reversed direction
      // (sys.rounding → ban.receivables). §2.2.
      const lineKind = residueSign > 0 ? "charge" : "release";

      const doc = await documentRepository.insert(tx, "ADJ", {
        state: "draft",
        refFinancialAccountId: fa.financialAccountId,
        refBillingAccountId: ban.billingAccountId,
        reasonCode: "ROUNDING_ADJ",
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
        lineKind,
        refBillingAccountId: ban.billingAccountId,
        refSettledDocumentId: null,
        amount: input.amount,
        pgledgerTransferId: null,
        reversedByLineId: null,
        lastEditedBy: actorId,
      });

      const submitted = await submitDocument(tx, doc.documentId, actorId);
      if (!submitted.ok) throw new _SubmitFailed(submitted);
      if (submitted.value.state !== "posted") return submitted;

      // §2.4 — live read inside the same transaction (Module Inv. #2), same
      // convention as `raise-credit-note.ts`/`raise-debit-note.ts`.
      const postBalance = await ledgerRepository.balanceByLedgerAccountId(
        tx,
        rec.pgledgerAccountId,
      );
      const newStatus =
        money.openReceivable(postBalance ?? "0.00") > 0n ? "due" : "paid";
      await billingAccountRepository.updatePaymentStatus(
        tx,
        ban.billingAccountId,
        newStatus,
      );

      return submitted;
    })
    .catch((e: unknown) => {
      if (e instanceof _SubmitFailed) return e.result;
      throw e;
    });
}
