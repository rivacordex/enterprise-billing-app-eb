"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { captureDeposit } from "@/services/accounts/capture-deposit";
import type { CaptureDepositResult } from "@/services/accounts/capture-deposit";
import { captureDepositSchema } from "@/validation/accounts/capture-deposit.schema";

export type CaptureDepositActionResult =
  | CaptureDepositResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac08-spec §2.5 — the context strip requires `?fa` before this action is
// even reachable from the UI (greyed-out state); re-validated here
// server-side regardless (code-standards §3.5).
export async function captureDepositAction(
  rawInput: unknown,
): Promise<CaptureDepositActionResult> {
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

  const parsed = captureDepositSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await captureDeposit(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
