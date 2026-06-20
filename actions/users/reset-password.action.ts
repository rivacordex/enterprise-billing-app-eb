"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import * as usersWriteService from "@/services/users/users-write.service";
import { resetPasswordSchema } from "@/validation/reset-password.schema";

export type ResetPasswordActionResult =
  | { ok: true; tempPassword: string }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "NOT_LOCAL_USER" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um14-spec §14.4. Mirrors `disableUserAction`'s FORBIDDEN-mapping pattern —
// this action is called from a client panel, not a page navigation, so an
// actual authorization failure (the guard's `redirect()`, a thrown
// `NEXT_REDIRECT` digest error) maps to a typed `FORBIDDEN` result instead of
// letting it propagate. Any other thrown error is a real unexpected failure
// and must not be misreported as `FORBIDDEN`.
export async function resetPasswordAction(
  rawInput: unknown,
): Promise<ResetPasswordActionResult> {
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

  const parsed = resetPasswordSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await usersWriteService.resetLocalPassword(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/administration/users");

  return { ok: true, tempPassword: result.tempPassword };
}
