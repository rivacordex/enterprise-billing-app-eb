"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { updateConfigValue } from "@/services/system-config/system-config-write.service";
import { updateConfigValueSchema } from "@/validation/update-config.schema";

export type UpdateConfigActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "SECRET_ROW" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um23-spec §23.5. Mirrors `updateRoleAction`/`deleteRoleAction`'s
// FORBIDDEN-mapping pattern. No DB access here — delegates entirely to
// `system-config-write.service`.
export async function updateConfigAction(
  rawInput: unknown,
): Promise<UpdateConfigActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.SYSTEM_CONFIG,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = updateConfigValueSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await updateConfigValue(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return result;
  }

  revalidatePath("/administration/system-config");

  return { ok: true };
}
