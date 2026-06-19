"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import * as usersWriteService from "@/services/users/users-write.service";
import { updateUserDetailsSchema } from "@/validation/update-user-details.schema";

export type UpdateUserDetailsActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um11-spec §11.6. Mirrors `createUserAction`'s FORBIDDEN-mapping pattern
// (um08-spec §8.5 deviation) — this action is called from a client panel,
// not a page navigation, so an unauthorized caller gets a typed result
// instead of letting the guard's `redirect()` propagate.
export async function updateUserDetailsAction(
  rawInput: unknown,
): Promise<UpdateUserDetailsActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.USERS,
      LEVELS.EDIT,
    ));
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = updateUserDetailsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await usersWriteService.updateUserDetails(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/administration/users");

  return { ok: true };
}
