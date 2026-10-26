// cm21-spec §3.5 (binding plan D12, custmgmt Inv. #13) — the light read
// behind the Manage Customer Billing account panel: every BAN of the
// customer with its state, CAS token and template label. No balances or
// documents (that is cm20's summary). Accounts are found by the party-role
// key, never party_role.account; one template-label read per distinct type
// per request (cm23 D5).

import { db } from "@/db/client";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import {
  resolveBanTemplateLabels,
  templateLabelFor,
} from "@/services/accounts/resolve-ban-template-label";
import type { AccountState, CustomerBillingAccounts } from "@/types/accounts";

export async function listCustomerBillingAccounts(
  partyRoleId: string,
): Promise<CustomerBillingAccounts> {
  const fas = await financialAccountRepository.findByPartyRoleIds(db, [
    partyRoleId,
  ]);
  if (fas.length === 0) return { onboarded: false };

  const bansPerFa = await Promise.all(
    fas.map((fa) =>
      billingAccountRepository.findByFinancialAccountId(
        db,
        fa.financialAccountId,
      ),
    ),
  );
  const bans = bansPerFa.flat();
  const labels = await resolveBanTemplateLabels(
    db,
    bans.map((ban) => ban.refBillTemplateFamilyId),
  );

  return {
    onboarded: true,
    bans: bans
      .sort((a, b) => a.billingAccountId.localeCompare(b.billingAccountId))
      .map((ban) => ({
        billingAccountId: ban.billingAccountId,
        name: ban.name,
        state: ban.state as AccountState,
        lastModified: ban.lastModified,
        refBillTemplateFamilyId: ban.refBillTemplateFamilyId,
        templateLabel: templateLabelFor(labels, ban.refBillTemplateFamilyId),
      })),
  };
}
