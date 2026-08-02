"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { closePeriod } from "@/services/accounts/period-close";
import type { ClosePeriodResult } from "@/services/accounts/period-close";
import { closePeriodSchema } from "@/validation/accounts/close-period.schema";

export type ClosePeriodActionResult =
  | ClosePeriodResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// ac14-spec §3.4 / §2.1 — close-period action. Requires accounts_config:EDIT.
// No reopening path (Q9, Module Inv. #7).
export async function closePeriodAction(
  rawInput: unknown,
): Promise<ClosePeriodActionResult> {
  let actorId: string;
  try {
    const { userId } = await requirePermission(
      PERMISSIONS.ACCOUNTS_CONFIG,
      LEVELS.EDIT,
    );
    actorId = userId;
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = closePeriodSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await closePeriod(
    parsed.data.period,
    parsed.data.currency,
    actorId,
  );

  if (result.ok) {
    revalidatePath("/accounts/gl-journal");
  }

  return result;
}
