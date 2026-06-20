"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import * as rolesWriteService from "@/services/roles/roles-write.service";
import { deleteRoleSchema } from "@/validation/delete-role.schema";

export type DeleteRoleActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "SEEDED_ROLE" }
  | { ok: false; code: "ROLE_IN_USE"; assignedCount: number }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um21-spec §21.5. Mirrors `updateRoleAction`/`setPermissionMappingAction`'s
// FORBIDDEN-mapping pattern. No DB access here — delegates entirely to
// `rolesWriteService`.
export async function deleteRoleAction(
  rawInput: unknown,
): Promise<DeleteRoleActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.ROLES,
      LEVELS.DELETE,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = deleteRoleSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await rolesWriteService.deleteRole(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return result;
  }

  revalidatePath("/administration/roles");

  return { ok: true };
}
