import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { financialAccount } from "@/db/schema/billing/accounts";
import type {
  FinancialAccount,
  FinancialAccountInsert,
} from "@/db/schema/billing/accounts";

// Skeleton (ac02-spec §2.6/§3.5) — `findById` is the trivial reader the
// fixture test needs; `insert` is the seam `services/accounts/
// onboard-customer-accounts.ts` fills (ac05).
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
    throw new Error("not implemented (ac05)");
  },
};
