"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { closeBillingAccount } from "@/services/accounts/close-billing-account";
import type { CloseBillingAccountResult } from "@/services/accounts/close-billing-account";
import { closeBillingAccountSchema } from "@/validation/accounts/close-account.schema";

export type CloseBillingAccountActionResult =
  | CloseBillingAccountResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac16-spec §2.1/§3.4 — close-BAN: zero-balance gated (CLOSURE_BLOCKED
// otherwise), server-validated regardless of the UI's greyed-out state.
export async function closeBillingAccountAction(
  rawInput: unknown,
): Promise<CloseBillingAccountActionResult> {
  let actorId: string;
  try {
    const { userId } = await requirePermission(
      PERMISSIONS.ACCOUNTS_TRANSACTIONS,
      LEVELS.EDIT,
    );
    actorId = userId;
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = closeBillingAccountSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await closeBillingAccount(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
