"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import * as rolesWriteService from "@/services/roles/roles-write.service";
import { setPermissionLevelSchema } from "@/validation/set-permission-level.schema";

export type SetPermissionLevelActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "AUDIT_LOG_READONLY" }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um20-spec §20.4. Mirrors `updateRoleAction`'s FORBIDDEN-mapping pattern.
// No DB access here — delegates entirely to `rolesWriteService`.
// `PERMISSION_NOT_FOUND` (a data-integrity guard that should never fire with
// seeded data) is masked to `SERVER_ERROR` so the action's typed surface
// doesn't leak an internal-only code.
export async function setPermissionMappingAction(
  rawInput: unknown,
): Promise<SetPermissionLevelActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.ROLES,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = setPermissionLevelSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await rolesWriteService.setRolePermissionLevel(
      parsed.data,
      actorId,
    );
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    if (result.code === "PERMISSION_NOT_FOUND") {
      return { ok: false, code: "SERVER_ERROR" };
    }
    return { ok: false, code: result.code };
  }

  revalidatePath("/administration/roles");

  return { ok: true };
}
