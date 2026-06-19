"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import * as usersWriteService from "@/services/users/users-write.service";
import { revokeRoleSchema } from "@/validation/revoke-role.schema";

export type RevokeRoleActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "ASSIGNMENT_NOT_FOUND" }
  | { ok: false; code: "LAST_ADMIN_ROLE" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um12-spec §12.9. Same pattern as `assignRoleAction`.
export async function revokeRoleAction(
  rawInput: unknown,
): Promise<RevokeRoleActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    ));
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = revokeRoleSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await usersWriteService.revokeRole(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/administration/users");

  return { ok: true };
}
