// ac16-spec §2.1/§2.4/§2.5, Module Inv. #12 (Q11) — the three zero-balance /
// open-account checks, centralized so `close-billing-account.ts`,
// `close-financial-account.ts`, the guided wizard's re-checks, and the
// Customer → CLOSED touchpoint all share one definition. Every check reads
// balances/states live inside the caller's connection (Module Inv. #2,
// code-standards §1.5) — never trusts a client-supplied figure.

import { db } from "@/db/client";
import type { Database } from "@/db/client";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import * as money from "@/services/accounts/money";

export type BillingAccountClosureEligibility =
  | { ok: true; eligible: true }
  | { ok: true; eligible: false; openReceivable: string }
  | { ok: false; code: "BILLING_ACCOUNT_NOT_FOUND" };

// close-BAN gate (§2.1): live A/R = 0.
export async function canCloseBillingAccount(
  dbOrTx: Database,
  billingAccountId: string,
): Promise<BillingAccountClosureEligibility> {
  const ban = await billingAccountRepository.findById(dbOrTx, billingAccountId);
  if (!ban) return { ok: false, code: "BILLING_ACCOUNT_NOT_FOUND" };

  const bindings = await ledgerBindingRepository.findByOwner(
    dbOrTx,
    "billing_account",
    billingAccountId,
  );
  const rec = bindings.find((b) => b.ledgerRole === "receivables");
  if (!rec) {
    throw new Error(
      `receivables binding not found for BAN ${billingAccountId}`,
    );
  }
  const balance = await ledgerRepository.balanceByLedgerAccountId(
    dbOrTx,
    rec.pgledgerAccountId,
  );
  const openReceivable = balance ?? "0.00";
  if (money.compare(openReceivable, "0.00") !== 0) {
    return { ok: true, eligible: false, openReceivable };
  }
  return { ok: true, eligible: true };
}

export type FinancialAccountClosureEligibility =
  | { ok: true; eligible: true }
  | {
      ok: true;
      eligible: false;
      unappliedCash: string;
      deposits: string;
      openBillingAccountIds: string[];
    }
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" };

// close-FA gate (§2.1): live unapplied_cash = 0, deposits = 0, and every BAN
// under it is `closed`.
export async function canCloseFinancialAccount(
  dbOrTx: Database,
  financialAccountId: string,
): Promise<FinancialAccountClosureEligibility> {
  const fa = await financialAccountRepository.findById(
    dbOrTx,
    financialAccountId,
  );
  if (!fa) return { ok: false, code: "FINANCIAL_ACCOUNT_NOT_FOUND" };

  const bindings = await ledgerBindingRepository.findByOwner(
    dbOrTx,
    "financial_account",
    financialAccountId,
  );
  const uc = bindings.find((b) => b.ledgerRole === "unapplied_cash");
  const dep = bindings.find((b) => b.ledgerRole === "deposits");
  if (!uc || !dep) {
    throw new Error(
      `unapplied_cash/deposits binding not found for FA ${financialAccountId}`,
    );
  }

  const [ucBalanceRaw, depBalanceRaw, bans] = await Promise.all([
    ledgerRepository.balanceByLedgerAccountId(dbOrTx, uc.pgledgerAccountId),
    ledgerRepository.balanceByLedgerAccountId(dbOrTx, dep.pgledgerAccountId),
    billingAccountRepository.findByFinancialAccountId(
      dbOrTx,
      financialAccountId,
    ),
  ]);
  const unappliedCash = ucBalanceRaw ?? "0.00";
  const deposits = depBalanceRaw ?? "0.00";
  const openBillingAccountIds = bans
    .filter((b) => b.state !== "closed")
    .map((b) => b.billingAccountId);

  if (
    money.compare(unappliedCash, "0.00") !== 0 ||
    money.compare(deposits, "0.00") !== 0 ||
    openBillingAccountIds.length > 0
  ) {
    return {
      ok: true,
      eligible: false,
      unappliedCash,
      deposits,
      openBillingAccountIds,
    };
  }
  return { ok: true, eligible: true };
}

// Default-`db`-bound read wrappers for server components (Transactions
// page's closure panel, §3.5) — pages may depend on `services/**` but not
// `db/**` directly (eslint-plugin-boundaries), same convention as
// `get-financial-account-detail.ts`/`get-billing-account-detail.ts`.
export function getBillingAccountClosureEligibility(
  billingAccountId: string,
): Promise<BillingAccountClosureEligibility> {
  return canCloseBillingAccount(db, billingAccountId);
}

export function getFinancialAccountClosureEligibility(
  financialAccountId: string,
): Promise<FinancialAccountClosureEligibility> {
  return canCloseFinancialAccount(db, financialAccountId);
}

// cm10 touchpoint (§2.4) — the Customer → CLOSED transition action calls
// this before allowing the transition. Customer never queries `billing.*`
// directly (code-standards §3.4); this is the one seam. Not tx-scoped: the
// Customer transition and this check are two separate services/tables with
// no shared atomicity requirement (a race here just means the check runs
// again on the next attempt, same as any other pre-transaction fast-fail
// in this module, e.g. `onboardCustomerAccounts`'s INITIALIZED check).
export async function customerHasOpenAccounts(
  partyRoleId: string,
): Promise<boolean> {
  const fas = await financialAccountRepository.findByPartyRoleIds(db, [
    partyRoleId,
  ]);
  for (const fa of fas) {
    if (fa.state !== "closed") return true;
    const bans = await billingAccountRepository.findByFinancialAccountId(
      db,
      fa.financialAccountId,
    );
    if (bans.some((b) => b.state !== "closed")) return true;
  }
  return false;
}
