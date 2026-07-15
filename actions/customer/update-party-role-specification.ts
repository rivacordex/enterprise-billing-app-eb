"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { updatePartyRoleSpecification } from "@/services/customer/update-party-role-specification";
import { updatePartyRoleSpecificationSchema } from "@/validation/customer/update-party-role-specification.schema";

export type UpdatePartyRoleSpecificationActionResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "PARTY_ROLE_NOT_FOUND" }
  | { ok: false; code: "INVALID_SPECIFICATION" }
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// Same shape as every prior mutation action. Only revalidates this edit
// page — unlike status, the specification never appears in
// `CustomerSearchResult`, so `/customers/manage` has nothing to refresh.
export async function updatePartyRoleSpecificationAction(
  rawInput: unknown,
): Promise<UpdatePartyRoleSpecificationActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    ));
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = updatePartyRoleSpecificationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await updatePartyRoleSpecification(parsed.data, actorId);
  if (result.ok) {
    revalidatePath(`/customers/manage/${parsed.data.partyRoleId}`);
  }
  return result;
}
