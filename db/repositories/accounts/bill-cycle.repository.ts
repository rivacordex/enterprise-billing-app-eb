import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billCycle } from "@/db/schema/billing/catalogs";
import type { BillCycle } from "@/db/schema/billing/catalogs";

export const billCycleRepository = {
  async findById(db: Database, billCycleId: string): Promise<BillCycle | null> {
    const [row] = await db
      .select()
      .from(billCycle)
      .where(eq(billCycle.billCycleId, billCycleId))
      .limit(1);
    return row ?? null;
  },

  async findAllActive(db: Database): Promise<BillCycle[]> {
    return db.select().from(billCycle).where(eq(billCycle.state, "active"));
  },
};
