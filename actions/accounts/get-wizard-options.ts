"use server";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { db } from "@/db/client";
import { listPriorAccountsForParty } from "@/services/accounts/list-prior-accounts";
import type { PriorAccountSummary } from "@/services/accounts/list-prior-accounts";

export interface WizardOptions {
  activeCycles: { billCycleId: string; name: string; paymentDueDays: number }[];
  defaults: {
    currency: string;
    defaultBillCycleId: string | null;
    defaultCreditLimit: string | null;
  };
  priorAccounts: PriorAccountSummary[];
}

// Returns the data the onboarding wizard needs to render:
//   - active bill cycles for the selector
//   - seeded wizard defaults (ACCOUNTS_DEFAULT_*)
//   - prior financial accounts for this org (returning-customer gate, §2.4)
export async function getWizardOptionsAction(
  partyRoleId: string,
): Promise<WizardOptions | null> {
  try {
    await requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.EDIT);
  } catch {
    return null;
  }

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
