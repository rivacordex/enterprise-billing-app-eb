"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { insertPrice } from "@/services/product/insert-price";
import { insertPriceSchema } from "@/validation/product/insert-price.schema";

export type InsertPriceActionResult =
  | {
      ok: true;
      offeringId: string;
      productOfferingPriceId: string;
      branched: boolean;
      backdated: boolean;
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "BACKDATED_START_TOO_FAR" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm22-spec §3.2. `offeringId` travels as its own parameter, never inside
// `rawInput` (Design §2.3, mirroring pm15's `insertPrice` and pm20's
// `updateOfferingAction` shape).
export async function insertPriceAction(
  offeringId: string,
  rawInput: unknown,
): Promise<InsertPriceActionResult> {
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

  const parsed = insertPriceSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await insertPrice(offeringId, parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  // Both product pages, matching create-offering.action.ts (pm19) and
  // update-offering.action.ts (pm20)'s identical precedent.
  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return {
    ok: true,
    offeringId: result.offeringId,
    productOfferingPriceId: result.productOfferingPriceId,
    branched: result.branched,
    backdated: result.backdated,
  };
}
