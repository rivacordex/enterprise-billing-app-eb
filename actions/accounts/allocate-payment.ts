"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { allocatePayment } from "@/services/accounts/allocate-payment";
import type { AllocatePaymentResult } from "@/services/accounts/allocate-payment";
import { allocatePaymentSchema } from "@/validation/accounts/allocate-payment.schema";

export type AllocatePaymentActionResult =
  | AllocatePaymentResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac07-spec §2.5/§3.6 — allocation additionally requires `?ban` (Q1); the
// context strip greys the action out until then, and this re-validates
// server-side via the Zod schema regardless.
export async function allocatePaymentAction(
  rawInput: unknown,
): Promise<AllocatePaymentActionResult> {
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

  const parsed = allocatePaymentSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await allocatePayment(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
