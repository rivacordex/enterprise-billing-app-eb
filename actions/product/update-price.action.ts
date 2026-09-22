"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { updatePrice } from "@/services/product/update-price";
import type { UnitOfMeasure } from "@/types/product";
import { updatePriceSchema } from "@/validation/product/update-price.schema";

export type UpdatePriceActionResult =
  | {
      ok: true;
      offeringId: string;
      productOfferingPriceId: string;
      backdated: boolean;
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "PRICE_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT" }
  | { ok: false; code: "BACKDATED_START_TOO_FAR" }
  | { ok: false; code: "DUPLICATE_START" }
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

// pm38-spec I5. Follows insert-price.action.ts line for line; the price id
// travels as its own parameter, never inside `rawInput` (the pm22 convention).
export async function updatePriceAction(
  priceId: string,
  rawInput: unknown,
): Promise<UpdatePriceActionResult> {
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

  const parsed = updatePriceSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await updatePrice(priceId, parsed.data, actorId);
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
    backdated: result.backdated,
  };
}
