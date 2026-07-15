"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { updateOrganization } from "@/services/customer/update-organization";
import { updateOrganizationSchema } from "@/validation/customer/update-organization.schema";

export type UpdateOrganizationActionResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "ORGANIZATION_NOT_FOUND" }
  | { ok: false; code: "DUPLICATE_REGISTRATION_NUMBER" }
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// cm08-spec §3.5. Same shape as cm07's create-customer action — guard,
// safeParse, one service call, revalidate. Revalidates both this edit page
// (the literal path, since `[id]` is a real known value here, not a pattern)
// and `/customers/manage` — a name change can affect search results there
// too, so both routes are refreshed on a successful update.
export async function updateOrganizationAction(
  rawInput: unknown,
): Promise<UpdateOrganizationActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    ));
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = updateOrganizationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await updateOrganization(parsed.data, actorId);
  if (result.ok) {
    revalidatePath(`/customers/manage/${parsed.data.partyRoleId}`);
    revalidatePath("/customers/manage");
  }
  return result;
}
