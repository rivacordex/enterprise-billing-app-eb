"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { meetsLevel } from "@/types/permissions";
import { setBillingAccountTemplate } from "@/services/accounts/set-billing-account-template";
import type { SetBillingAccountTemplateResult } from "@/services/accounts/set-billing-account-template";
import { setBillingAccountTemplateSchema } from "@/validation/accounts/set-billing-account-template.schema";

export type SetBillingAccountTemplateActionResult =
  | SetBillingAccountTemplateResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// cm21-spec §2/§3.6 (custmgmt Inv. #16) — dual permission, both re-checked
// here whatever the panel rendered: customers:EDIT (the Manage Customer page)
// AND accounts_transactions:EDIT (writing a billing account).
export async function setBillingAccountTemplateAction(
  rawInput: unknown,
): Promise<SetBillingAccountTemplateActionResult> {
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
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = setBillingAccountTemplateSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await setBillingAccountTemplate(parsed.data, actorId);

  if (result.ok) {
    revalidatePath(`/customers/manage/${parsed.data.partyRoleId}`);
    revalidatePath(`/customers/view/${parsed.data.partyRoleId}`);
  }

  return result;
}
