"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import * as usersWriteService from "@/services/users/users-write.service";
import { createUserSchema } from "@/validation/create-user.schema";

export type CreateUserActionResult =
  | { ok: true; userId: string; tempPassword: string | null }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "EMAIL_CONFLICT" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um08-spec §8.5. `requirePermission` fails by calling `redirect()` (a
// thrown `NEXT_REDIRECT` digest error, um06-spec §6.5) for an actual
// authorization failure — this action is called from a dialog, not a page
// navigation, so that maps to a typed `FORBIDDEN` result instead of an
// actual redirect. Any other thrown error (e.g. a DB failure inside
// `findUserById`/`resolveEffectivePermissions`) is a real unexpected
// failure and must not be misreported as `FORBIDDEN`.
export async function createUserAction(
  rawInput: unknown,
): Promise<CreateUserActionResult> {
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

  const parsed = createUserSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await usersWriteService.createUser(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/administration/users");

  return { ok: true, userId: result.userId, tempPassword: result.tempPassword };
}
