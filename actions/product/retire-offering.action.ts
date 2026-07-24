"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { retireOffering } from "@/services/product/retire-offering";
import { retireOfferingSchema } from "@/validation/product/retire-offering.schema";

export type RetireOfferingActionResult =
  | {
      ok: true;
      offeringId: string;
      eventType: "PRODUCT_OFFERING_RETIRED" | "PRODUCT_OFFERING_DISCARDED";
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm23-spec §3.3. One action, one service call, handles both Retire and
// Discard (code-standards-phase2 §1 rule 11) — the caller never tells this
// action which of the two it "meant"; retireOffering (pm16) derives eventType
// entirely from the target's own status before the transaction opens. Gated
// at products:DELETE, not EDIT (Design §2.3; architecture-phase2 §4).
export async function retireOfferingAction(
  offeringId: string,
  rawInput: unknown,
): Promise<RetireOfferingActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.PRODUCTS,
      LEVELS.DELETE,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = retireOfferingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await retireOffering(offeringId, parsed.data, actorId);
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
    eventType: result.eventType,
  };
}
