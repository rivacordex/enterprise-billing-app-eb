import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { orderItemPriceOverride } from "@/db/schema/ordering";
import type {
  OrderItemPriceOverride,
  OrderItemPriceOverrideInsert,
} from "@/types/ordering";

// Permanently insert-only (architecture Inv. #16): a negotiated price is
// either absent or an immutable, manager-approved override row — there is no
// editable price column anywhere, and no code path ever UPDATEs or DELETEs an
// override. This repository exports `insertOverride` + finders and nothing
// else, asserted structurally by tests/db/ordering-repository-exports.test.ts
// (pm03 precedent).
export const orderItemPriceOverrideRepository = {
  async insertOverride(
    tx: Database,
    data: OrderItemPriceOverrideInsert,
  ): Promise<OrderItemPriceOverride> {
    const [row] = await tx
      .insert(orderItemPriceOverride)
      .values(data)
      .returning();
    if (!row) {
      throw new Error("insertOverride: insert returned no row");
    }
    return row;
  },

  // All overrides for one order item (0..n, one per flat price_type by the
  // UNIQUE constraint), ordered by price_type for a stable read.
  async findByItemId(
    db: Database,
    productOrderItemId: string,
  ): Promise<OrderItemPriceOverride[]> {
    return db
      .select()
      .from(orderItemPriceOverride)
      .where(eq(orderItemPriceOverride.productOrderItemId, productOrderItemId))
      .orderBy(asc(orderItemPriceOverride.priceType));
  },
};
