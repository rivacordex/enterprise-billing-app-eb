"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { updateSpecification } from "@/services/product/update-specification";
import { updateSpecificationSchema } from "@/validation/product/update-specification.schema";

export type UpdateSpecificationActionResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "SPECIFICATION_NOT_FOUND" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm21-spec §3.6. Both specId and offeringId travel as separate function
// parameters (Design §2.1) — updateSpecification(specId, offeringId, input, actorId).
export async function updateSpecificationAction(
  specId: string,
  offeringId: string,
  rawInput: unknown,
): Promise<UpdateSpecificationActionResult> {
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

  const parsed = updateSpecificationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await updateSpecification(
      specId,
      offeringId,
      parsed.data,
      actorId,
    );
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
