"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { createOffering } from "@/services/product/create-offering";
import { createOfferingSchema } from "@/validation/product/create-offering.schema";

export type CreateOfferingActionResult =
  | { ok: true; offeringId: string }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm19-spec §3.2. Mirrors createRoleAction's guard → safeParse → delegate →
// revalidatePath shape (architecture-phase2 §1), simplified: pm11's
// createOffering has no NAME_CONFLICT-style failure branch, so there is no
// `if (!result.ok)` fork here at all — it always succeeds once past
// validation, or throws (caught below).
export async function createOfferingAction(
  rawInput: unknown,
): Promise<CreateOfferingActionResult> {
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

  const parsed = createOfferingSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result: { ok: true; offeringId: string };
  try {
    result = await createOffering(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  // Both product pages, per pm99's literal contract for this unit
  // ("revalidatePath both product pages") — Manage Products shows the new
  // row directly; View Product's own list/detail queries are also
  // invalidated even though a fresh DRAFT won't appear there under its
  // default filter until activated.
  revalidatePath("/products/manage-products");
  revalidatePath("/products/product-offering");

  return { ok: true, offeringId: result.offeringId };
}
