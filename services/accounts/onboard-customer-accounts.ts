import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { partyRoleRepository } from "@/db/repositories/party-role";
import type { OnboardCustomerAccountsInput } from "@/validation/accounts/onboard-customer-accounts.schema";

export type OnboardCustomerAccountsResult =
  | {
      ok: true;
      value: {
        financialAccountId: string;
        billingAccountId: string;
        ledgerAccountNames: [string, string, string];
        lastModifiedDatetime: Date;
      };
    }
  | { ok: false; code: "PARTY_ROLE_NOT_FOUND" }
  | { ok: false; code: "INVALID_TRANSITION" }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "CYCLE_RETIRED" };

// ac04-spec §2.2 + §3.1 — single atomic transaction owned by this service:
//   1. compareAndUpdateStatus → INITIALIZED → VALIDATED (cm10 seam)
//   2a. inserts billing.financial_account (FIN…)
//   2b. inserts billing.billing_account (BAN…)
//   2c. pgledger_create_account ×3
//   2d. inserts three ledger_binding rows
//   3. writes ACCOUNTS_ONBOARDED audit event
//
// Expected business-outcome failures (PARTY_ROLE_NOT_FOUND, INVALID_TRANSITION,
// CONFLICT, CYCLE_RETIRED) are returned as Result codes. Uncaught repository,
// ledger, and audit infrastructure failures propagate as thrown exceptions and
// are rolled back by db.transaction automatically (V7).
export async function onboardCustomerAccounts(
  input: OnboardCustomerAccountsInput,
  actorId: string,
): Promise<OnboardCustomerAccountsResult> {
  // Pre-transaction fast-fail: avoid opening a transaction when the customer
  // does not exist or is already past INITIALIZED.
  const before = await partyRoleRepository.findById(db, input.partyRoleId);
  if (!before) return { ok: false, code: "PARTY_ROLE_NOT_FOUND" };
  if (before.status !== "INITIALIZED") {
    return { ok: false, code: "INVALID_TRANSITION" };
  }

  return db.transaction(async (tx) => {
    // Validate cycle is still active inside the transaction so a retirement
    // racing the wizard open is caught before any writes.
    const cycle = await billCycleRepository.findById(tx, input.billCycleId);
    if (!cycle || cycle.state !== "active") {
      return { ok: false, code: "CYCLE_RETIRED" };
    }

    // Step 1 — status change (optimistic lock; null = stale → CONFLICT).
    const after = await partyRoleRepository.compareAndUpdateStatus(
      tx,
      input.partyRoleId,
      input.lastModifiedDatetime,
      {
        status: "VALIDATED",
        statusReason: input.statusReason,
        lastModifiedBy: actorId,
      },
    );
    if (!after) return { ok: false, code: "CONFLICT" };

    // Step 2a — Financial Account.
    const fa = await financialAccountRepository.insert(tx, {
      name: "Financial Account",
      refPartyRoleId: input.partyRoleId,
      currency: input.currency,
      creditLimitAmount: input.faCreditLimit ?? null,
      lastEditedBy: actorId,
    });

    // Step 2b — Billing Account (Master).
    const ban = await billingAccountRepository.insert(tx, {
      name: "Master Billing Account",
      refPartyRoleId: input.partyRoleId,
      refFinancialAccountId: fa.financialAccountId,
      currency: input.currency,
      ratingType: "postpaid",
      paymentStatus: "paid",
      creditLimitAmount: input.banCreditLimit ?? null,
      refBillCycleId: input.billCycleId,
      paymentDueDaysOverride: input.paymentDueDaysOverride ?? null,
      lastEditedBy: actorId,
    });

    // Step 2c — pgledger accounts (all MYR; Module Inv. #9 — currency
    // threaded through from the single `currency` field in input).
    const ucName = `fa.${fa.financialAccountId}.unapplied_cash`;
    const depName = `fa.${fa.financialAccountId}.deposits`;
    const recName = `ban.${ban.billingAccountId}.receivables`;

    const uc = await ledgerRepository.createAccount(tx, ucName, input.currency);
    const dep = await ledgerRepository.createAccount(
      tx,
      depName,
      input.currency,
    );
    const rec = await ledgerRepository.createAccount(
      tx,
      recName,
      input.currency,
    );

    // Step 2d — three ledger_binding rows (UNIQUE triple prevents duplicates).
    await ledgerBindingRepository.insert(tx, {
      ownerType: "financial_account",
      ownerId: fa.financialAccountId,
      ledgerRole: "unapplied_cash",
      pgledgerAccountId: uc.id,
      lastEditedBy: actorId,
    });
    await ledgerBindingRepository.insert(tx, {
      ownerType: "financial_account",
      ownerId: fa.financialAccountId,
      ledgerRole: "deposits",
      pgledgerAccountId: dep.id,
      lastEditedBy: actorId,
    });
    await ledgerBindingRepository.insert(tx, {
      ownerType: "billing_account",
      ownerId: ban.billingAccountId,
      ledgerRole: "receivables",
      pgledgerAccountId: rec.id,
      lastEditedBy: actorId,
    });

    // Step 3 — audit (same transaction; rollback on failure, Inv. #11).
    await insertAuditEvent(tx, {
      eventType: "ACCOUNTS_ONBOARDED",
      actorUserId: actorId,
      targetEntity: "FINANCIAL_ACCOUNT",
      targetId: fa.financialAccountId,
      beforeData: null,
      afterData: {
        financialAccountId: fa.financialAccountId,
        billingAccountId: ban.billingAccountId,
        partyRoleId: input.partyRoleId,
        ledgerAccountNames: [ucName, depName, recName],
      },
    });

    return {
      ok: true,
      value: {
        financialAccountId: fa.financialAccountId,
        billingAccountId: ban.billingAccountId,
        ledgerAccountNames: [ucName, depName, recName] as [
          string,
          string,
          string,
        ],
        lastModifiedDatetime: after.lastModifiedDatetime,
      },
    };
  });
}
