"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { submitForTesting } from "@/services/product/submit-for-testing";
import { transitionSchema } from "@/validation/product/transition.schema";

export type SubmitForTestingActionResult =
  | { ok: true; offeringId: string }
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

// pm42-spec I5. Submit for testing (DRAFT → TESTING) is gated at products:EDIT
// (architecture §4). Standard action shape: requirePermission → safeParse →
// service → revalidate both product pages. Precondition failures (NO_PRICE_ROWS
// / SPECIFICATIONS_NOT_RESOLVED) pass through so the UI can surface them at the
// panel that owns them, never as dialog copy (pm42 D6).
export async function submitForTestingAction(
  offeringId: string,
  rawInput: unknown,
): Promise<SubmitForTestingActionResult> {
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
    result = await submitForTesting(offeringId, parsed.data, actorId);
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
