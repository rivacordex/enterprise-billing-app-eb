"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { refundPayment } from "@/services/accounts/refund-payment";
import type { RefundPaymentResult } from "@/services/accounts/refund-payment";
import { refundPaymentSchema } from "@/validation/accounts/refund-payment.schema";

export type RefundPaymentActionResult =
  | RefundPaymentResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac07-spec §2.4b — always routes to `pending_approval` (reason
// `PAYMENT_REFUND`, `auto_post_limit = 0`); a non-creator MANAGER posts it
// via `approveDocumentAction`.
export async function refundPaymentAction(
  rawInput: unknown,
): Promise<RefundPaymentActionResult> {
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

  const parsed = refundPaymentSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await refundPayment(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
