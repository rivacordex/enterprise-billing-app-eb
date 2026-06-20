"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import * as usersWriteService from "@/services/users/users-write.service";
import { switchAuthMethodSchema } from "@/validation/switch-auth-method.schema";

export type SwitchAuthMethodActionResult =
  | { ok: true; newAuthMethod: "LOCAL"; tempPassword: string }
  | { ok: true; newAuthMethod: "SSO" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "USER_DELETED" }
  | { ok: false; code: "ALREADY_METHOD" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um16-spec §16.4. Mirrors `resetPasswordAction`'s FORBIDDEN-mapping
// pattern — this action is called from a client panel, not a page
// navigation, so an actual authorization failure (the guard's `redirect()`,
// a thrown `NEXT_REDIRECT` digest error) maps to a typed `FORBIDDEN` result
// instead of propagating. Any other thrown error is a real unexpected
// failure and must not be misreported as `FORBIDDEN`. Self-switching is
// permitted; the consequence (own session revoked) is surfaced in the UI.
export async function switchAuthMethodAction(
  rawInput: unknown,
): Promise<SwitchAuthMethodActionResult> {
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

  const parsed = switchAuthMethodSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await usersWriteService.switchAuthMethod(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/administration/users");

  if (result.newAuthMethod === "LOCAL") {
    return {
      ok: true,
      newAuthMethod: "LOCAL",
      tempPassword: result.tempPassword,
    };
  }
  return { ok: true, newAuthMethod: "SSO" };
}
