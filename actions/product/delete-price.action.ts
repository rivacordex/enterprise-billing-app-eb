"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { deletePrice } from "@/services/product/delete-price";
import type { UnitOfMeasure } from "@/types/product";

export type DeletePriceActionResult =
  | { ok: true; offeringId: string; productOfferingPriceId: string }
  | { ok: false; code: "PRICE_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT" }
  | {
      ok: false;
      code: "MODIFIER_WITHOUT_BASE_RATE";
      unitOfMeasure: UnitOfMeasure;
    }
  | { ok: false; code: "AMBIGUOUS_BASE_RATE" }
  | {
      ok: false;
      code: "CURRENCY_MISMATCH";
      existingCurrency: string;
      candidateCurrency: string;
    }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm38-spec I5. Follows insert-price.action.ts line for line, but takes only the
// price id — a delete needs no `rawInput` to parse. The id travels as its own
// parameter, never inside a payload object (the pm22 convention).
export async function deletePriceAction(
  priceId: string,
): Promise<DeletePriceActionResult> {
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
    result = await deletePrice(priceId, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    // Returned as-is — pm49's three violation codes carry extra fields the
    // UI needs (code-standards §3.7); `{ ok: false, code: result.code }`
    // would silently discard them.
    return result;
  }

  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return {
    ok: true,
    offeringId: result.offeringId,
    productOfferingPriceId: result.productOfferingPriceId,
  };
}
