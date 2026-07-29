import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { accountingPeriod } from "@/db/schema/billing/periods";
import type { AccountingPeriod } from "@/db/schema/billing/periods";

export const accountingPeriodRepository = {
  async findByPeriodAndCurrency(
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
};
