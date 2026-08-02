"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { upsertGlMapping } from "@/services/accounts/gl-mapping";
import type { UpsertGlMappingResult } from "@/services/accounts/gl-mapping";
import { upsertGlMappingSchema } from "@/validation/accounts/gl-mapping.schema";

export type UpsertGlMappingActionResult =
  | UpsertGlMappingResult
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

export async function upsertGlMappingAction(
  rawInput: unknown,
): Promise<UpsertGlMappingActionResult> {
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

  const parsed = upsertGlMappingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const result = await upsertGlMapping(parsed.data, actorId);

  if (result.ok) {
    revalidatePath("/accounts/chart-of-accounts");
  }

  return result;
}
