import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billCycle } from "@/db/schema/billing/catalogs";
import type { BillCycle, BillCycleInsert } from "@/db/schema/billing/catalogs";

// Skeleton (ac02-spec §2.6/§3.5) — only `findById` is real; catalog CRUD is
// the Accounts Settings unit.
export const billCycleRepository = {
  async findById(db: Database, billCycleId: string): Promise<BillCycle | null> {
    const [row] = await db
      .select()
      .from(billCycle)
      .where(eq(billCycle.billCycleId, billCycleId))
      .limit(1);
    return row ?? null;
  },

  async insert(_tx: Database, _data: BillCycleInsert): Promise<BillCycle> {
    void _tx;
    void _data;
    throw new Error(
      "not implemented — filled in by the Accounts Settings unit",
    );
  },
};
