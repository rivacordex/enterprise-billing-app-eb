"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { meetsLevel } from "@/types/permissions";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { onboardCustomerAccountsSchema } from "@/validation/accounts/onboard-customer-accounts.schema";

export type OnboardCustomerAccountsActionResult =
  | {
      ok: true;
      value: {
        financialAccountId: string;
        billingAccountId: string;
        ledgerAccountNames: [string, string, string];
        lastModifiedDatetime: Date;
      };
    }
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "PARTY_ROLE_NOT_FOUND" }
  | { ok: false; code: "INVALID_TRANSITION" }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "CYCLE_RETIRED" };

// ac04-spec §2.6 + §3.3 — dual permission check: accounts_transactions:EDIT
// (creating money accounts) AND customers:EDIT (the VALIDATED transition).
// Both are re-checked here independent of which UI rendered the wizard.
export async function onboardCustomerAccountsAction(
  rawInput: unknown,
): Promise<OnboardCustomerAccountsActionResult> {
  let actorId: string;
  try {
    const { userId, permissionMap } = await requirePermission(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    );
    if (
      !meetsLevel(permissionMap[PERMISSIONS.ACCOUNTS_TRANSACTIONS], LEVELS.EDIT)
    ) {
      return { ok: false, code: "FORBIDDEN" };
    }
    actorId = userId;
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = onboardCustomerAccountsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await onboardCustomerAccounts(parsed.data, actorId);

  if (result.ok) {
    revalidatePath(`/customers/manage/${parsed.data.partyRoleId}`);
    revalidatePath("/customers/manage");
  }

  return result;
}
