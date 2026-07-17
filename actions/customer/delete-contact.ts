"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { deleteContact } from "@/services/customer/contact-mutations";
import { deleteContactSchema } from "@/validation/customer/delete-contact.schema";

export type DeleteContactActionResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "CONTACT_NOT_FOUND" }
  | { ok: false; code: "CANNOT_DELETE_PREFERRED_CONTACT" }
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// Same shape as every prior mutation action (cm11-spec §3.5) — guard,
// safeParse, one service call, revalidate the edit page. The client-side
// confirm dialog (cm13-spec §3.4) happens in `ContactManagerPanel` before
// this action is even called; the actual boundary is the guard + the
// service's precondition check, since this is a public endpoint regardless
// of what the UI omits (code-standards §1.2).
export async function deleteContactAction(
  rawInput: unknown,
): Promise<DeleteContactActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    ));
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = deleteContactSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await deleteContact(parsed.data, actorId);
  if (result.ok) {
    revalidatePath(`/customers/manage/${parsed.data.partyRoleId}`);
  }
  return result;
}
