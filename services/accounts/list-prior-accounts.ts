import { db } from "@/db/client";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { partyRoleRepository } from "@/db/repositories/party-role";
import type { PriorAccountSummary } from "@/types/accounts";

// ac04-spec §3.5 — thin service that the wizard options action wraps.
// Returns all financial accounts belonging to the same organisation as
// `partyRoleId`, regardless of which specific party role created them.
// An INITIALIZED customer with no prior history returns an empty array.
export async function listPriorAccountsForParty(
  partyRoleId: string,
): Promise<PriorAccountSummary[]> {
  const role = await partyRoleRepository.findById(db, partyRoleId);
  if (!role) return [];

  return financialAccountRepository.findByEngagedParty(db, role.engagedParty);
}
