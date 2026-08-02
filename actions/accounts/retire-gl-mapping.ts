"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { retireGlMapping } from "@/services/accounts/gl-mapping";
import type { RetireGlMappingResult } from "@/services/accounts/gl-mapping";
import { retireGlMappingSchema } from "@/validation/accounts/gl-mapping.schema";

export type RetireGlMappingActionResult =
  | RetireGlMappingResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

export async function retireGlMappingAction(
  rawInput: unknown,
): Promise<RetireGlMappingActionResult> {
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

  const parsed = retireGlMappingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await retireGlMapping(
    parsed.data.glMappingId,
    new Date(parsed.data.lastModified),
    actorId,
  );

  if (result.ok) {
    revalidatePath("/accounts/chart-of-accounts");
  }

  return result;
}
