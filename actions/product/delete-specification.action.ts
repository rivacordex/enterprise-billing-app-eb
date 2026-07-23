"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { deleteSpecification } from "@/services/product/delete-specification";

export type DeleteSpecificationActionResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "SPECIFICATION_NOT_FOUND" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm21-spec §3.7. No Zod schema — no delete schema exists in this phase
// (pm14-spec §3.2), and specId/offeringId are plain, unvalidated function
// parameters, mirroring update-offering.action.ts's own offeringId
// parameter precedent (Design §2.1). This unit's UI only ever calls this
// action against a DRAFT-status offering (Design §2.8) — the RETIRED/
// ACTIVE guards below are handled defensively anyway, matching pm14's own
// "guard it even though the shipped UI can't reach it" stance.
export async function deleteSpecificationAction(
  specId: string,
  offeringId: string,
): Promise<DeleteSpecificationActionResult> {
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

  let result;
  try {
    result = await deleteSpecification(specId, offeringId, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return {
    ok: true,
    offeringId: result.offeringId,
    productSpecId: result.productSpecId,
    branched: result.branched,
  };
}
