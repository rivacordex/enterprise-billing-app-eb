import { expect } from "vitest";

import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import { inventoryStatusHistoryRepository } from "@/db/repositories/inventory/inventory-status-history.repository";
import type { Database } from "@/db/client";

// The append-only, gap-free derivability assert (architecture Inv. #18):
// after every lifecycle mutation, the instance's `status` column must equal
// its latest history row's `to_status`. pm32-spec §3 asks for this as a
// reusable helper the pm34 sweep also calls — kept here, not inline in one
// test file, for that reuse.
export async function assertInventoryGapFree(
  db: Database,
  productInventoryId: string,
): Promise<void> {
  const [inventory, latest] = await Promise.all([
    productInventoryRepository.findById(db, productInventoryId),
    inventoryStatusHistoryRepository.findLatestByInventoryId(
      db,
      productInventoryId,
    ),
  ]);
  expect(inventory).not.toBeNull();
  expect(latest).not.toBeNull();
  expect(inventory!.status).toBe(latest!.toStatus);
}
