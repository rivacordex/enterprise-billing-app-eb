// cm21-spec §3.5 (binding plan D12, custmgmt Inv. #13) — the light read
// behind the Manage Customer Billing account panel: every BAN of the
// customer with its state, CAS token and template label. No balances or
// documents (that is cm20's summary). Accounts are found by the party-role
// key, never party_role.account; one template-label lookup per request.

import { db } from "@/db/client";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { logger } from "@/lib/logger";
import {
  banTemplateLabel,
  resolveCurrentTemplateLabel,
} from "@/services/accounts/resolve-ban-template-label";
import type { AccountState, CustomerBillingAccounts } from "@/types/accounts";

export async function listCustomerBillingAccounts(
  partyRoleId: string,
): Promise<CustomerBillingAccounts> {
  const fas = await financialAccountRepository.findByPartyRoleIds(db, [
    partyRoleId,
  ]);
  if (fas.length === 0) return { onboarded: false };

  const [currentLabel, bansPerFa] = await Promise.all([
    resolveCurrentTemplateLabel(db),
    Promise.all(
      fas.map((fa) =>
        billingAccountRepository.findByFinancialAccountId(
          db,
          fa.financialAccountId,
        ),
      ),
    ),
  ]);

  return {
    onboarded: true,
    bans: bansPerFa
      .flat()
      .sort((a, b) => a.billingAccountId.localeCompare(b.billingAccountId))
      .map((ban) => {
        if (ban.refBillTemplateVersionId !== null) {
          // Unreachable in v1 (cm18/cm21 reject it); never resolved here —
          // banTemplateLabel's contract leaves the warning to the caller,
          // same as getCustomerAccountsSummary.
          logger.warn("Unsupported BAN invoice template reference.", {
            billingAccountId: ban.billingAccountId,
            refBillTemplateVersionId: ban.refBillTemplateVersionId,
          });
        }
        return {
          billingAccountId: ban.billingAccountId,
          name: ban.name,
          state: ban.state as AccountState,
          lastModified: ban.lastModified,
          refBillTemplateVersionId: ban.refBillTemplateVersionId,
          templateLabel: banTemplateLabel(
            ban.refBillTemplateVersionId,
            currentLabel,
          ),
        };
      }),
  };
}
