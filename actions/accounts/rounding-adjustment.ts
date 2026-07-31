"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { roundingAdjustment } from "@/services/accounts/rounding-adjustment";
import type { RoundingAdjustmentResult } from "@/services/accounts/rounding-adjustment";
import { roundingAdjustmentSchema } from "@/validation/accounts/rounding-adjustment.schema";

export type RoundingAdjustmentActionResult =
  | RoundingAdjustmentResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac10-spec §2.1/§3.4 — rounding additionally requires `?ban` (Q1); the
// context strip greys the action out until then, and this re-validates
// server-side via the Zod schema regardless.
export async function roundingAdjustmentAction(
  rawInput: unknown,
): Promise<RoundingAdjustmentActionResult> {
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

  const parsed = roundingAdjustmentSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await roundingAdjustment(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/transactions");
    revalidatePath("/accounts/overview");
    revalidatePath("/accounts/ledger");
  }

  return result;
}
