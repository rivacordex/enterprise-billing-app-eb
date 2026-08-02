"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { createGlCode } from "@/services/accounts/gl-account";
import type { CreateGlCodeResult } from "@/services/accounts/gl-account";
import { createGlCodeSchema } from "@/validation/accounts/gl-account.schema";

export type CreateGlCodeActionResult =
  | CreateGlCodeResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

export async function createGlCodeAction(
  rawInput: unknown,
): Promise<CreateGlCodeActionResult> {
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

  const parsed = createGlCodeSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await createGlCode(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/chart-of-accounts");
  }

  return result;
}
