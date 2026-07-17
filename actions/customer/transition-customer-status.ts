"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { transitionCustomerStatus } from "@/services/customer/transition-customer-status";
import { transitionCustomerStatusSchema } from "@/validation/customer/transition-customer-status.schema";

export type TransitionCustomerStatusActionResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "PARTY_ROLE_NOT_FOUND" }
  | { ok: false; code: "INVALID_TRANSITION" }
  | { ok: false; code: "FORBIDDEN" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    };

// Same shape as cm09's transitionOrganizationStatusAction — guard,
// safeParse, one service call, revalidate both this edit page and the
// manage-search page (a customer's status shows in search results too, via
// `CustomerSearchResult.customerStatus`).
export async function transitionCustomerStatusAction(
  rawInput: unknown,
): Promise<TransitionCustomerStatusActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.CUSTOMERS,
      LEVELS.EDIT,
    ));
  } catch {
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = transitionCustomerStatusSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const result = await transitionCustomerStatus(parsed.data, actorId);
  if (result.ok) {
    revalidatePath(`/customers/manage/${parsed.data.partyRoleId}`);
    revalidatePath("/customers/manage");
  }
  return result;
}
