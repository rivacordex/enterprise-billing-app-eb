import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { productOrderItem } from "@/db/schema/ordering";
import type {
  ProductOrderItem,
  ProductOrderItemInsert,
} from "@/types/ordering";

// Write-once (architecture Inv. #15): an order item's billing-relevant core
// (`product_offering_id`, `quantity`, `start_date`, `ordered_characteristics`)
// never changes after creation — corrections are terminate + re-order. This
// repository exports `insertItem` + finders only; no update/delete, ever.
export const productOrderItemRepository = {
  async insertItem(
    tx: Database,
    data: ProductOrderItemInsert,
  ): Promise<ProductOrderItem> {
    const [row] = await tx.insert(productOrderItem).values(data).returning();
    if (!row) {
      throw new Error("insertItem: insert returned no row");
    }
    return row;
  },

  // All items for one order (the phase's UI creates exactly one; the schema
  // supports many), ordered by id for a stable read.
  async findByOrderId(
    db: Database,
    productOrderId: string,
  ): Promise<ProductOrderItem[]> {
    return db
      .select()
      .from(productOrderItem)
      .where(eq(productOrderItem.productOrderId, productOrderId))
      .orderBy(asc(productOrderItem.productOrderItemId));
  },
};
