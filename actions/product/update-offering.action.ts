"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { updateOffering } from "@/services/product/update-offering";
import { updateOfferingSchema } from "@/validation/product/update-offering.schema";

export type UpdateOfferingActionResult =
  | { ok: true; offeringId: string; branched: boolean }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm20-spec §3.4. `offeringId` travels as its own parameter, never inside
// `rawInput` (Design §2.2) — mirrors `updateOffering`'s own shape (pm13).
export async function updateOfferingAction(
  offeringId: string,
  rawInput: unknown,
): Promise<UpdateOfferingActionResult> {
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

  const parsed = updateOfferingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await updateOffering(offeringId, parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  // Both product pages, matching create-offering.action.ts's precedent
  // (pm19-spec §3.2) — Manage Products shows the updated/branched row
  // directly; View Product's own queries are invalidated too, relevant once
  // a branched sibling is later activated.
  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return { ok: true, offeringId: result.offeringId, branched: result.branched };
}
