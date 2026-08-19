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
import type { TerminateSubscriptionInput } from "@/validation/inventory/terminate.schema";

export type TerminateSubscriptionErrorCode =
  | LifecycleErrorCode
  | "END_BEFORE_START";

export type TerminateSubscriptionResult =
  | { ok: true; inventoryId: string; status: "TERMINATED" }
  | { ok: false; code: TerminateSubscriptionErrorCode };

// pm32-spec §2 — ACTIVE|SUSPENDED → TERMINATED, terminal. `end_date` is the
// last billed day (architecture Inv. #21) and is both the history row's
// `effective_date` and the instance's `end_date`. `END_BEFORE_START` is
// checked here, ahead of the DB CHECK (`end_date >= start_date`) that
// backstops it — same defense-in-depth shape as the module's other
// service-level pre-checks.
export async function terminateSubscription(
  input: TerminateSubscriptionInput,
  actorId: string,
  now: () => Date = () => new Date(),
): Promise<TerminateSubscriptionResult> {
  return db.transaction(async (tx) => {
    const inventory = await productInventoryRepository.findByIdForUpdate(
      tx,
      input.inventoryId,
    );
    if (!inventory) {
      return { ok: false, code: "SUBSCRIPTION_NOT_FOUND" };
    }
    if (!isLegalTransition(inventory.status, "TERMINATED")) {
      return { ok: false, code: "INVALID_TRANSITION" };
    }

    if (input.endDate < inventory.startDate) {
      return { ok: false, code: "END_BEFORE_START" };
    }

    if (isBackdatedTooFar(input.endDate, now())) {
      return { ok: false, code: "BACKDATED_EFFECTIVE_TOO_FAR" };
    }

    const latest =
      await inventoryStatusHistoryRepository.findLatestByInventoryId(
        tx,
        input.inventoryId,
      );
    if (
      isBeforeLatestEffectiveDate(input.endDate, latest?.effectiveDate ?? null)
    ) {
      return { ok: false, code: "EFFECTIVE_DATE_BEFORE_PRIOR" };
    }

    await inventoryStatusHistoryRepository.insertTransition(tx, {
      productInventoryId: inventory.productInventoryId,
      fromStatus: inventory.status,
      toStatus: "TERMINATED",
      effectiveDate: input.endDate,
      reason: input.reason,
      changedBy: actorId,
    });

    await productInventoryRepository.updateStatus(
      tx,
      inventory.productInventoryId,
      { status: "TERMINATED", endDate: input.endDate },
    );

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_INVENTORY_TERMINATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_INVENTORY",
      targetId: inventory.productInventoryId,
      beforeData: { status: inventory.status },
      afterData: {
        status: "TERMINATED",
        endDate: input.endDate,
        reason: input.reason,
      },
    });

    return {
      ok: true,
      inventoryId: inventory.productInventoryId,
      status: "TERMINATED",
    };
  });
}
