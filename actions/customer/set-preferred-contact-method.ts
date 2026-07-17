"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { setPreferredContactMethod } from "@/services/customer/contact-mutations";
import { setPreferredContactMethodSchema } from "@/validation/customer/set-preferred-contact-method.schema";

export type SetPreferredContactMethodActionResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "CONTACT_NOT_FOUND" }
  | { ok: false; code: "METHOD_NOT_POPULATED" }
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// Same shape as every prior mutation action (cm11-spec §3.5) — guard,
// safeParse, one service call, revalidate the edit page.
export async function setPreferredContactMethodAction(
  rawInput: unknown,
): Promise<SetPreferredContactMethodActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    ));
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = setPreferredContactMethodSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await setPreferredContactMethod(parsed.data, actorId);
  if (result.ok) {
    revalidatePath(`/customers/manage/${parsed.data.partyRoleId}`);
  }
  return result;
}
