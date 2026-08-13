import { db } from "@/db/client";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import { inventoryStatusHistoryRepository } from "@/db/repositories/inventory/inventory-status-history.repository";
import type {
  StatusHistoryEntry,
  SubscriptionDetail,
  SuspensionWindow,
} from "@/types/inventory";

// Derived from consecutive SUSPENDED/ACTIVE transitions (pm32-spec §1) — the
// reference derivation the future bill run reuses. A window opens on a
// transition INTO SUSPENDED and closes on the next transition OUT OF
// SUSPENDED (resume or terminate, whichever ends the suspended period first);
// an unresumed suspension stays open (`to: null`).
export function deriveSuspensionWindows(
  history: StatusHistoryEntry[],
): SuspensionWindow[] {
  const windows: SuspensionWindow[] = [];
  let open: SuspensionWindow | null = null;
  for (const entry of history) {
    if (entry.to === "SUSPENDED") {
      open = { from: entry.effectiveDate, to: null };
      windows.push(open);
    } else if (entry.from === "SUSPENDED" && open) {
      open.to = entry.effectiveDate;
      open = null;
    }
  }
  return windows;
}

// Backs the subscription detail view: the list-row shape (pm32-spec §1) plus
// `instance_characteristics`, the ordered transition history, and the
// derived suspension windows, computed once here. Returns `null` for an
// unknown id (general §2.9 — no throw for expected control flow).
export async function getSubscriptionDetail(
  inventoryId: string,
): Promise<SubscriptionDetail | null> {
  const row = await productInventoryRepository.findDetailById(db, inventoryId);
  if (!row) return null;

  const historyRows =
    await inventoryStatusHistoryRepository.findByInventoryIdWithChangedByName(
      db,
      inventoryId,
    );
  const history: StatusHistoryEntry[] = historyRows.map((entry) => ({
    from: entry.fromStatus,
    to: entry.toStatus,
    effectiveDate: entry.effectiveDate,
    reason: entry.reason,
    changedByName: entry.changedByName,
    createdAt: entry.createdAt,
  }));

  return {
    ...row,
    history,
    suspensionWindows: deriveSuspensionWindows(history),
  };
}
