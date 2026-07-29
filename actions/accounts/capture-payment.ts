"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { capturePayment } from "@/services/accounts/capture-payment";
import type { CapturePaymentResult } from "@/services/accounts/capture-payment";
import { capturePaymentSchema } from "@/validation/accounts/capture-payment.schema";

export type CapturePaymentActionResult =
  | CapturePaymentResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac07-spec §2.5/§3.6 — the context strip requires `?fa` before this action
// is even reachable from the UI (greyed-out state); re-validated here
// server-side regardless (code-standards §3.5).
export async function capturePaymentAction(
  rawInput: unknown,
): Promise<CapturePaymentActionResult> {
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

  const parsed = capturePaymentSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await capturePayment(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
