import type { Database } from "@/db/client";
import type { BillCycle } from "@/db/schema/billing/catalogs";

// Skeleton (ac02-spec §2.6/§3.5). Reader/CRUD seam for the bill-cycle
// catalog — filled by ac03 (seed) and the Accounts Settings config unit.
export const billCycleRepository = {
  async findById(
    _db: Database,
    _billCycleId: string,
  ): Promise<BillCycle | null> {
    throw new Error("not implemented (ac03)");
  },
};
