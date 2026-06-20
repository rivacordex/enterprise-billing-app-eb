"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import * as usersWriteService from "@/services/users/users-write.service";
import { unlockAccountSchema } from "@/validation/unlock-account.schema";

export type UnlockAccountActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "NOT_LOCKED" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um15-spec §15.4. Mirrors `resetPasswordAction`'s FORBIDDEN-mapping
// pattern — this action is called from a client panel, not a page
// navigation, so an actual authorization failure (the guard's `redirect()`,
// a thrown `NEXT_REDIRECT` digest error) maps to a typed `FORBIDDEN` result
// instead of letting it propagate. Any other thrown error is a real
// unexpected failure and must not be misreported as `FORBIDDEN`.
export async function unlockAccountAction(
  rawInput: unknown,
): Promise<UnlockAccountActionResult> {
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

  const parsed = unlockAccountSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await usersWriteService.unlockAccount(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/administration/users");

  return { ok: true };
}
