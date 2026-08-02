"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { retireGlCode } from "@/services/accounts/gl-account";
import type { RetireGlCodeResult } from "@/services/accounts/gl-account";
import { retireGlCodeSchema } from "@/validation/accounts/gl-account.schema";

export type RetireGlCodeActionResult =
  | RetireGlCodeResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

export async function retireGlCodeAction(
  rawInput: unknown,
): Promise<RetireGlCodeActionResult> {
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

  const parsed = retireGlCodeSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await retireGlCode(
    parsed.data.glCode,
    new Date(parsed.data.lastModified),
    actorId,
  );

  if (result.ok) {
    revalidatePath("/accounts/chart-of-accounts");
  }

  return result;
}
