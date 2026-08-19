import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import type { UpdateCharacteristicsInput } from "@/validation/inventory/update-characteristics.schema";

export const UPDATE_CHARACTERISTICS_ERROR_CODES = [
  "SUBSCRIPTION_NOT_FOUND",
  "SUBSCRIPTION_TERMINATED",
] as const;
export type UpdateCharacteristicsErrorCode =
  (typeof UPDATE_CHARACTERISTICS_ERROR_CODES)[number];

export type UpdateInstanceCharacteristicsResult =
  | { ok: true; inventoryId: string }
  | { ok: false; code: UpdateCharacteristicsErrorCode };

// pm32-spec §2 — `instance_characteristics` is the sole editable field (Inv.
// #15): its own service, own audit event, no status/date/quantity/offering
// interaction. Locked read (any non-TERMINATED status) → write →
// `PRODUCT_INVENTORY_CHARACTERISTICS_UPDATED` with the before/after payload.
export async function updateInstanceCharacteristics(
  input: UpdateCharacteristicsInput,
  actorId: string,
): Promise<UpdateInstanceCharacteristicsResult> {
  return db.transaction(async (tx) => {
    const inventory = await productInventoryRepository.findByIdForUpdate(
      tx,
      input.inventoryId,
    );
    if (!inventory) {
      return { ok: false, code: "SUBSCRIPTION_NOT_FOUND" };
    }
    if (inventory.status === "TERMINATED") {
      return { ok: false, code: "SUBSCRIPTION_TERMINATED" };
    }

    await productInventoryRepository.updateCharacteristics(
      tx,
      inventory.productInventoryId,
      input.characteristics,
    );

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_INVENTORY_CHARACTERISTICS_UPDATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_INVENTORY",
      targetId: inventory.productInventoryId,
      beforeData: {
        instanceCharacteristics: inventory.instanceCharacteristics ?? null,
      },
      afterData: { instanceCharacteristics: input.characteristics },
    });

    return { ok: true, inventoryId: inventory.productInventoryId };
  });
}
