"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { refundDeposit } from "@/services/accounts/refund-deposit";
import type { RefundDepositResult } from "@/services/accounts/refund-deposit";
import { refundDepositSchema } from "@/validation/accounts/refund-deposit.schema";

export type RefundDepositActionResult =
  | RefundDepositResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac08-spec §2.4/§2.5 — always routes to `pending_approval` (reason
// `DEP_REFUND`, `auto_post_limit = 0`); a non-creator MANAGER posts it via
// `approveDocumentAction`.
export async function refundDepositAction(
  rawInput: unknown,
): Promise<RefundDepositActionResult> {
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

  const parsed = refundDepositSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await refundDeposit(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
