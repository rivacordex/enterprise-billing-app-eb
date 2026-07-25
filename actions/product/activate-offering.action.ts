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
  | { ok: false; code: "OFFERING_NOT_DRAFT" }
  | { ok: false; code: "NO_PRICE_ROWS" }
  | { ok: false; code: "SPECIFICATIONS_NOT_RESOLVED" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm23-spec §3.2. Activate is gated at products:EDIT, not DELETE (Design
// §2.3; architecture-phase2 §4) — the only permission-level difference
// between this file and retire-offering.action.ts below.
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
