import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { inventoryStatusHistory } from "@/db/schema/inventory";
import type {
  InventoryStatusHistory,
  InventoryStatusHistoryInsert,
} from "@/types/inventory";

// Append-only, gap-free transition log (architecture Inv. #18): every status
// an instance ever held is a row; the `status` column is always derivable from
// the latest row. This repository permanently exports no update/delete —
// `insertTransition` + finders and nothing else, asserted structurally by
// tests/db/ordering-repository-exports.test.ts.
export const inventoryStatusHistoryRepository = {
  async insertTransition(
    tx: Database,
    data: InventoryStatusHistoryInsert,
  ): Promise<InventoryStatusHistory> {
    const [row] = await tx
      .insert(inventoryStatusHistory)
      .values(data)
      .returning();
    if (!row) {
      throw new Error("insertTransition: insert returned no row");
    }
    return row;
  },

  // Full transition history for one instance, oldest-to-newest by insert time
  // (`created_at`) — the creation row (`from_status IS NULL`) first, then each
  // transition in the order it was applied. Consumers derive suspension windows
  // from consecutive rows.
  async findByInventoryId(
    db: Database,
    productInventoryId: string,
  ): Promise<InventoryStatusHistory[]> {
    return db
      .select()
      .from(inventoryStatusHistory)
      .where(eq(inventoryStatusHistory.productInventoryId, productInventoryId))
      .orderBy(
        asc(inventoryStatusHistory.createdAt),
        asc(inventoryStatusHistory.inventoryStatusHistoryId),
      );
  },
};
