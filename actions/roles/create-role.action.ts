"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import * as rolesWriteService from "@/services/roles/roles-write.service";
import { createRoleSchema } from "@/validation/create-role.schema";

export type CreateRoleActionResult =
  | { ok: true; roleId: string }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "NAME_CONFLICT" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// um19-spec §19.4.1. Mirrors `assignRoleAction`/`disableUserAction`'s
// FORBIDDEN-mapping pattern — called from a client dialog, not a page
// navigation, so an actual authorization failure (the guard's `redirect()`)
// maps to a typed `FORBIDDEN` result instead of letting it propagate. No DB
// access here — delegates entirely to `rolesWriteService`.
export async function createRoleAction(
  rawInput: unknown,
): Promise<CreateRoleActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.ROLES,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = createRoleSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await rolesWriteService.createRole(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/administration/roles");

  return { ok: true, roleId: result.roleId };
}
