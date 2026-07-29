"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { reverseDeposit } from "@/services/accounts/reverse-deposit";
import type { ReverseDepositResult } from "@/services/accounts/reverse-deposit";
import { reverseDepositSchema } from "@/validation/accounts/reverse-deposit.schema";

export type ReverseDepositActionResult =
  | ReverseDepositResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac08-spec §2.4/§2.5 — always routes to `pending_approval` (reason
// `DEP_REVERSE`, `auto_post_limit = 0`); a non-creator MANAGER posts it via
// `approveDocumentAction`.
export async function reverseDepositAction(
  rawInput: unknown,
): Promise<ReverseDepositActionResult> {
  let actorId: string;
  try {
    const { userId } = await requirePermission(
      PERMISSIONS.ACCOUNTS_TRANSACTIONS,
      LEVELS.EDIT,
    );
    actorId = userId;
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = reverseDepositSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await reverseDeposit(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
