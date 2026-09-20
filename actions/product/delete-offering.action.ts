"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { deleteOffering } from "@/services/product/delete-offering";
import type { LifecycleStatus } from "@/types/product";
import { transitionSchema } from "@/validation/product/transition.schema";

export type DeleteOfferingActionResult =
  | {
      ok: true;
      offeringId: string;
      familyId: string;
      familyRemains: boolean;
      specificationsRemoved: number;
      pricesRemoved: number;
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | {
      ok: false;
      code: "OFFERING_NOT_DELETABLE";
      lifecycleStatus: LifecycleStatus;
    }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm44-spec I3. Discard (hard delete of a DRAFT/TESTING version) is gated at
// products:DELETE (architecture §4). Standard shape: requirePermission →
// safeParse → service → revalidate both product pages. Returns the family id +
// whether the family still has versions so the UI can navigate off the deleted
// ?version= (to the family's remaining primary version, or the bare list).
export async function deleteOfferingAction(
  offeringId: string,
  rawInput: unknown,
): Promise<DeleteOfferingActionResult> {
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
    result = await deleteOffering(offeringId, parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return result.code === "OFFERING_NOT_DELETABLE"
      ? {
          ok: false,
          code: result.code,
          lifecycleStatus: result.lifecycleStatus,
        }
      : { ok: false, code: result.code };
  }

  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return {
    ok: true,
    offeringId: result.offeringId,
    familyId: result.familyId,
    familyRemains: result.familyRemains,
    specificationsRemoved: result.specificationsRemoved,
    pricesRemoved: result.pricesRemoved,
  };
}
