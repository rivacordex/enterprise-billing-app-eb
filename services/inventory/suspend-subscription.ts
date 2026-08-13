import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import { inventoryStatusHistoryRepository } from "@/db/repositories/inventory/inventory-status-history.repository";
import {
  isBackdatedTooFar,
  isBeforeLatestEffectiveDate,
  isLegalTransition,
  type LifecycleErrorCode,
} from "@/services/inventory/lifecycle-guards";
import type { SuspendSubscriptionInput } from "@/validation/inventory/suspend.schema";

export type SuspendSubscriptionResult =
  | { ok: true; inventoryId: string; status: "SUSPENDED" }
  | { ok: false; code: LifecycleErrorCode };

// pm32-spec §2 — ACTIVE → SUSPENDED. One transaction: locked read → transition
// + date checks → append transition + flip status → audit. `now` is
// injectable (pm15/pm28 pattern) so tests pin the backdating boundary.
export async function suspendSubscription(
  input: SuspendSubscriptionInput,
  actorId: string,
  now: () => Date = () => new Date(),
): Promise<SuspendSubscriptionResult> {
  return db.transaction(async (tx) => {
    const inventory = await productInventoryRepository.findByIdForUpdate(
      tx,
      input.inventoryId,
    );
    if (!inventory) {
      return { ok: false, code: "SUBSCRIPTION_NOT_FOUND" };
    }
    if (!isLegalTransition(inventory.status, "SUSPENDED")) {
      return { ok: false, code: "INVALID_TRANSITION" };
    }

    if (isBackdatedTooFar(input.effectiveDate, now())) {
      return { ok: false, code: "BACKDATED_EFFECTIVE_TOO_FAR" };
    }

    const latest =
      await inventoryStatusHistoryRepository.findLatestByInventoryId(
        tx,
        input.inventoryId,
      );
    if (
      isBeforeLatestEffectiveDate(
        input.effectiveDate,
        latest?.effectiveDate ?? null,
      )
    ) {
      return { ok: false, code: "EFFECTIVE_DATE_BEFORE_PRIOR" };
    }

    await inventoryStatusHistoryRepository.insertTransition(tx, {
      productInventoryId: inventory.productInventoryId,
      fromStatus: inventory.status,
      toStatus: "SUSPENDED",
      effectiveDate: input.effectiveDate,
      reason: input.reason,
      changedBy: actorId,
    });

    await productInventoryRepository.updateStatus(
      tx,
      inventory.productInventoryId,
      { status: "SUSPENDED" },
    );

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_INVENTORY_SUSPENDED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_INVENTORY",
      targetId: inventory.productInventoryId,
      beforeData: { status: inventory.status },
      afterData: {
        status: "SUSPENDED",
        effectiveDate: input.effectiveDate,
        reason: input.reason,
      },
    });

    return {
      ok: true,
      inventoryId: inventory.productInventoryId,
      status: "SUSPENDED",
    };
  });
}
