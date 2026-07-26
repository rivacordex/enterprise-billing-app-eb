import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { financialAccount } from "@/db/schema/billing/accounts";
import type {
  FinancialAccount,
  FinancialAccountInsert,
} from "@/db/schema/billing/accounts";

// Skeleton (ac02-spec §2.6/§3.5) — only `findById` is real; every mutation
// is a later unit's onboarding/servicing use case.
export const financialAccountRepository = {
  async findById(
    db: Database,
    financialAccountId: string,
  ): Promise<FinancialAccount | null> {
    const [row] = await db
      .select()
      .from(financialAccount)
      .where(eq(financialAccount.financialAccountId, financialAccountId))
      .limit(1);
    return row ?? null;
  },

  async insert(
    _tx: Database,
    _data: FinancialAccountInsert,
  ): Promise<FinancialAccount> {
    void _tx;
    void _data;
    throw new Error(
      "not implemented — filled in by the customer-onboarding accounts unit",
    );
  },
};
