"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import * as usersWriteService from "@/services/users/users-write.service";
import { enableUserSchema } from "@/validation/enable-user.schema";

export type EnableUserActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um13-spec §13.4.2. Mirrors `disableUserAction`'s structure; no
// `LAST_ADMIN` code here — not applicable to enabling.
export async function enableUserAction(
  rawInput: unknown,
): Promise<EnableUserActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    ));
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = enableUserSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await usersWriteService.enableUser(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/administration/users");

  return { ok: true };
}
