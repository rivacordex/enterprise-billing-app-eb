import type { Database } from "@/db/client";
import type { AccountingPeriod } from "@/db/schema/billing/periods";

// Skeleton (ac02-spec §2.6/§3.5). Period-close seam (Q9/Q11) — filled by
// ac14.
export const accountingPeriodRepository = {
  async findByPeriodAndCurrency(
    _db: Database,
    _period: string,
    _currency: string,
  ): Promise<AccountingPeriod | null> {
    throw new Error("not implemented (ac14)");
  },
};
