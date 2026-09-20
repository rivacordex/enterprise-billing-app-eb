"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { activateOffering } from "@/services/product/activate-offering";
import { activateOfferingSchema } from "@/validation/product/activate-offering.schema";

export type ActivateOfferingActionResult =
  | { ok: true; offeringId: string; supersededOfferingId: string | null }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_TESTING" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm23-spec §3.2, amended pm42 I4/I5. Activate is gated at products:EDIT, not
// DELETE (architecture §4). Activation now flips TESTING → ACTIVE: the old
// OFFERING_NOT_DRAFT code is replaced by OFFERING_NOT_TESTING, and the release
// preconditions (NO_PRICE_ROWS / SPECIFICATIONS_NOT_RESOLVED) moved to
// submit-for-testing.action.ts, so they no longer surface here.
export async function activateOfferingAction(
  offeringId: string,
  rawInput: unknown,
): Promise<ActivateOfferingActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = activateOfferingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await activateOffering(offeringId, parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  // Both product pages, matching every prior mutation action's precedent —
  // Manage Products shows the flipped status (and any superseded sibling)
  // directly; View Product's own list/detail queries are also invalidated
  // since a newly-ACTIVE offering now appears there under its default filter.
  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return {
    ok: true,
    offeringId: result.offeringId,
    supersededOfferingId: result.supersededOfferingId,
  };
}
