"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { transitionOrganizationStatus } from "@/services/customer/transition-organization-status";
import { transitionOrganizationStatusSchema } from "@/validation/customer/transition-organization-status.schema";

export type TransitionOrganizationStatusActionResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "ORGANIZATION_NOT_FOUND" }
  | { ok: false; code: "INVALID_TRANSITION" }
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// Same shape as cm08's updateOrganizationAction — guard, safeParse, one
// service call, revalidate both this edit page and the manage-search page
// (an org's status shows in search results too).
export async function transitionOrganizationStatusAction(
  rawInput: unknown,
): Promise<TransitionOrganizationStatusActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    ));
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = transitionOrganizationStatusSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await transitionOrganizationStatus(parsed.data, actorId);
  if (result.ok) {
    revalidatePath(`/customers/manage/${parsed.data.partyRoleId}`);
    revalidatePath("/customers/manage");
  }
  return result;
}
