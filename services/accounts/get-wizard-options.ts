import { db } from "@/db/client";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import type { PriorAccountSummary } from "@/services/accounts/list-prior-accounts";
import { listPriorAccountsForParty } from "@/services/accounts/list-prior-accounts";

export interface WizardOptions {
  activeCycles: { billCycleId: string; name: string; paymentDueDays: number }[];
  defaults: {
    currency: string;
    defaultBillCycleId: string | null;
    defaultCreditLimit: string | null;
  };
  priorAccounts: PriorAccountSummary[];
}

export async function getWizardOptions(
  partyRoleId: string,
): Promise<WizardOptions> {
  const [
    rawCycles,
    defaultCycleId,
    defaultCurrency,
    defaultCreditLimit,
    priorAccounts,
  ] = await Promise.all([
    billCycleRepository.findAllActive(db),
    systemConfigRepository.findActiveValue(
      db,
      "accounts",
      "ACCOUNTS_DEFAULT_BILL_CYCLE",
    ),
    systemConfigRepository.findActiveValue(
      db,
      "accounts",
      "ACCOUNTS_DEFAULT_CURRENCY",
    ),
    systemConfigRepository.findActiveValue(
      db,
      "accounts",
      "ACCOUNTS_DEFAULT_CREDIT_LIMIT",
    ),
    listPriorAccountsForParty(partyRoleId),
  ]);

  return {
    activeCycles: rawCycles.map((c) => ({
      billCycleId: c.billCycleId,
      name: c.name,
      paymentDueDays: c.paymentDueDays,
    })),
    defaults: {
      currency: defaultCurrency ?? "MYR",
      defaultBillCycleId: defaultCycleId,
      defaultCreditLimit: defaultCreditLimit,
    },
    priorAccounts,
  };
}
