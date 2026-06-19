"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import * as usersWriteService from "@/services/users/users-write.service";
import { assignRoleSchema } from "@/validation/assign-role.schema";

export type AssignRoleActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "ALREADY_ASSIGNED" }
  | { ok: false; code: "CANNOT_ASSIGN_TO_DELETED_USER" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um12-spec §12.8. Mirrors `updateUserDetailsAction`'s FORBIDDEN-mapping
// pattern (um11-spec §11.6 / um08-spec §8.5 deviation) — called from a
// client panel, not a page navigation, so an unauthorized caller gets a
// typed result instead of letting the guard's `redirect()` propagate.
export async function assignRoleAction(
  rawInput: unknown,
): Promise<AssignRoleActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = assignRoleSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await usersWriteService.assignRole(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/administration/users");

  return { ok: true };
}
