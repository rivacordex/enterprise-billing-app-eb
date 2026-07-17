"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { addContact } from "@/services/customer/contact-mutations";
import { addContactSchema } from "@/validation/customer/add-contact.schema";

export type AddContactActionResult =
  | { ok: true; value: { contactMediumId: string; lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "PARTY_ROLE_NOT_FOUND" }
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// Same shape as every prior mutation action (cm11-spec §3.5) — guard,
// safeParse, one service call, revalidate the edit page. A contact mutation
// is a separate Server Action from the org/role update (code-standards
// §3.6), independently permission- and lock-checked.
export async function addContactAction(
  rawInput: unknown,
): Promise<AddContactActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    ));
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = addContactSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await addContact(parsed.data, actorId);
  if (result.ok) {
    revalidatePath(`/customers/manage/${parsed.data.partyRoleId}`);
  }
  return result;
}
