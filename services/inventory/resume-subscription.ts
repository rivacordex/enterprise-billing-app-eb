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
import type { ResumeSubscriptionInput } from "@/validation/inventory/resume.schema";

export type ResumeSubscriptionResult =
  | { ok: true; inventoryId: string; status: "ACTIVE" }
  | { ok: false; code: LifecycleErrorCode };

// pm32-spec §2 — SUSPENDED → ACTIVE. No reason (resume-day proration is
// reserved to the bill-run phase, Q17/Q20). Same one-transaction shape as
// suspend.
export async function resumeSubscription(
  input: ResumeSubscriptionInput,
  actorId: string,
  now: () => Date = () => new Date(),
): Promise<ResumeSubscriptionResult> {
  return db.transaction(async (tx) => {
    const inventory = await productInventoryRepository.findByIdForUpdate(
      tx,
      input.inventoryId,
    );
    if (!inventory) {
      return { ok: false, code: "SUBSCRIPTION_NOT_FOUND" };
    }
    if (!isLegalTransition(inventory.status, "ACTIVE")) {
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
      toStatus: "ACTIVE",
      effectiveDate: input.effectiveDate,
      reason: null,
      changedBy: actorId,
    });

    await productInventoryRepository.updateStatus(
      tx,
      inventory.productInventoryId,
      { status: "ACTIVE" },
    );

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_INVENTORY_RESUMED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_INVENTORY",
      targetId: inventory.productInventoryId,
      beforeData: { status: inventory.status },
      afterData: { status: "ACTIVE", effectiveDate: input.effectiveDate },
    });

    return {
      ok: true,
      inventoryId: inventory.productInventoryId,
      status: "ACTIVE",
    };
  });
}
