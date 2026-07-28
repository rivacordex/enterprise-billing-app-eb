import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { billingAccount } from "@/db/schema/billing/accounts";
import { accountView } from "@/db/schema/billing/views";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { stringToSen } from "@/services/accounts/money";
import type {
  BillingAccount,
  FinancialAccount,
  TmfRelatedParty,
} from "@/types/accounts";

export type FinancialAccountDetail = {
  fa: FinancialAccount;
  relatedParty: TmfRelatedParty[];
  receivableBalance: string;
  unappliedCashBalance: string;
  depositBalance: string;
  creditLimitAmount: string | null;
  utilisationPct: number | null;
  bans: Pick<
    BillingAccount,
    "billingAccountId" | "name" | "state" | "paymentStatus"
  >[];
};

// Reads FA base fields, related party, live balances, credit utilisation, and
// the list of BANs for the BAN selector in Section 2 (ac05-spec §2.4 / §3.4).
// All balances are live reads from pgledger_accounts_view (Module Inv. #2).
export async function getFinancialAccountDetail(
  faId: string,
): Promise<FinancialAccountDetail | null> {
  const fa = await financialAccountRepository.findById(db, faId);
  if (!fa) return null;

  // Related party from account_view (TMF composition, code-standards §2.6).
  const [viewRow] = await db
    .select()
    .from(accountView)
    .where(eq(accountView.accountId, faId))
    .limit(1);

  const relatedParty: TmfRelatedParty[] =
    viewRow?.relatedParty.map((p) => ({
      id: p.id,
      role: "customer" as const,
      name: p.name,
      "@referredType": "Customer" as const,
    })) ?? [];

  // FA-level bindings: unapplied_cash + deposits.
  const faBindings = await ledgerBindingRepository.findByOwner(
    db,
    "financial_account",
    faId,
  );

  const unappliedBinding = faBindings.find(
    (b) => b.ledgerRole === "unapplied_cash",
  );
  const depositBinding = faBindings.find((b) => b.ledgerRole === "deposits");

  const [unappliedCashBalance, depositBalance, receivableBalance] =
    await Promise.all([
      unappliedBinding
        ? ledgerRepository.balanceByLedgerAccountId(
            db,
            unappliedBinding.pgledgerAccountId,
          )
        : Promise.resolve("0.00"),
      depositBinding
        ? ledgerRepository.balanceByLedgerAccountId(
            db,
            depositBinding.pgledgerAccountId,
          )
        : Promise.resolve("0.00"),
      ledgerRepository.sumReceivablesForFinancialAccount(db, faId),
    ]);

  // Credit utilisation (computed in service — component receives display values).
  let utilisationPct: number | null = null;
  if (fa.creditLimitAmount !== null) {
    const limitSen = stringToSen(fa.creditLimitAmount);
    if (limitSen > 0n) {
      const usedSen = stringToSen(receivableBalance);
      utilisationPct = Number((usedSen * 10000n) / limitSen) / 100;
    } else {
      utilisationPct = 0;
    }
  }

  // BANs for the selector in Section 2 (ORM query, no raw SQL needed).
  const bans = await db
    .select({
      billingAccountId: billingAccount.billingAccountId,
      name: billingAccount.name,
      state: billingAccount.state,
      paymentStatus: billingAccount.paymentStatus,
    })
    .from(billingAccount)
    .where(eq(billingAccount.refFinancialAccountId, faId))
    .orderBy(billingAccount.billingAccountId);

  return {
    fa,
    relatedParty,
    receivableBalance,
    unappliedCashBalance,
    depositBalance,
    creditLimitAmount: fa.creditLimitAmount,
    utilisationPct,
    bans: bans.map((b) => ({
      billingAccountId: b.billingAccountId,
      name: b.name,
      state: b.state as BillingAccount["state"],
      paymentStatus: b.paymentStatus as BillingAccount["paymentStatus"],
    })),
  };
}
