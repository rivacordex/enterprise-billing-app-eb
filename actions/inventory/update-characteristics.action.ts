"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { updateInstanceCharacteristics } from "@/services/inventory/update-instance-characteristics";
import { updateCharacteristicsSchema } from "@/validation/inventory/update-characteristics.schema";
import type { UpdateCharacteristicsErrorCode } from "@/services/inventory/update-instance-characteristics";

export type UpdateCharacteristicsActionResult =
  | { ok: true; inventoryId: string }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: UpdateCharacteristicsErrorCode }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm33-spec §Implementation-3. Same shape as the other actions/inventory
// files. `instance_characteristics` is the sole editable, never-rated field
// (architecture Inv. #15) — this action never touches status/dates/quantity.
export async function updateCharacteristicsAction(
  rawInput: unknown,
): Promise<UpdateCharacteristicsActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.PRODUCT_INVENTORY,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = updateCharacteristicsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await updateInstanceCharacteristics(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/products/subscriptions");

  return { ok: true, inventoryId: result.inventoryId };
}
