"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { obsoleteOffering } from "@/services/product/obsolete-offering";
import { transitionSchema } from "@/validation/product/transition.schema";

export type ObsoleteOfferingActionResult =
  | { ok: true; offeringId: string }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_ACTIVE" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm43-spec I5. Stop selling (ACTIVE → OBSOLETE) is gated at products:DELETE, not
// EDIT — it changes what the catalog offers (D6, architecture §4). Standard
// action shape: requirePermission → safeParse → service → revalidate both product
// pages.
export async function obsoleteOfferingAction(
  offeringId: string,
  rawInput: unknown,
): Promise<ObsoleteOfferingActionResult> {
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

  const parsed = transitionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await obsoleteOffering(offeringId, parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return { ok: true, offeringId: result.offeringId };
}
