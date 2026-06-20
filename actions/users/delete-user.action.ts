"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import * as usersWriteService from "@/services/users/users-write.service";
import { deleteUserSchema } from "@/validation/delete-user.schema";

export type DeleteUserActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "LAST_ADMIN" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um17-spec §17.5. Tombstone-delete behind `users:DELETE`. Mirrors the
// FORBIDDEN-mapping pattern of the other user-mutation actions — this is
// called from the detail panel, not a page navigation, so the guard's
// `redirect()` (a thrown `NEXT_REDIRECT` digest error) maps to a typed
// `FORBIDDEN` result rather than propagating. Any other thrown error is a
// real unexpected failure and becomes `SERVER_ERROR`. No DB access here;
// the work is delegated entirely to `usersWriteService`.
export async function deleteUserAction(
  rawInput: unknown,
): Promise<DeleteUserActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.USERS,
      LEVELS.DELETE,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = deleteUserSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await usersWriteService.tombstoneDeleteUser(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/administration/users");

  return { ok: true };
}
