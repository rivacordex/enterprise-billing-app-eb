"use server";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { getWizardOptions } from "@/services/accounts/get-wizard-options";

import type { WizardOptions } from "@/types/accounts";

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

  return getWizardOptions(partyRoleId);
}
