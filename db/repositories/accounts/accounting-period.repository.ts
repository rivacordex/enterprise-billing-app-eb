import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { accountingPeriod } from "@/db/schema/billing/periods";
import type {
  AccountingPeriod,
  AccountingPeriodInsert,
} from "@/db/schema/billing/periods";

// Skeleton (ac02-spec §2.6/§3.5) — only `findById` is real; period-open
// seeding and close workflow are later units (ac03/ac14).
export const accountingPeriodRepository = {
  async findById(
    db: Database,
    period: string,
    currency: string,
  ): Promise<AccountingPeriod | null> {
    const [row] = await db
      .select()
      .from(accountingPeriod)
      .where(
        and(
          eq(accountingPeriod.period, period),
          eq(accountingPeriod.currency, currency),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async insert(
    _tx: Database,
    _data: AccountingPeriodInsert,
  ): Promise<AccountingPeriod> {
    void _tx;
    void _data;
    throw new Error("not implemented — filled in by ac03 (seeds)");
  },
};
