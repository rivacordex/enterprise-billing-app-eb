import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billingAccount } from "@/db/schema/billing/accounts";
import type {
  BillingAccount,
  BillingAccountInsert,
} from "@/db/schema/billing/accounts";

// Skeleton (ac02-spec §2.6/§3.5) — `findById` is the trivial reader the
// fixture test needs; `insert` is the seam `services/accounts/
// onboard-customer-accounts.ts` fills (ac05).
export const billingAccountRepository = {
  async findById(
    db: Database,
    billingAccountId: string,
  ): Promise<BillingAccount | null> {
    const [row] = await db
      .select()
      .from(billingAccount)
      .where(eq(billingAccount.billingAccountId, billingAccountId))
      .limit(1);
    return row ?? null;
  },

  async insert(
    _tx: Database,
    _data: BillingAccountInsert,
  ): Promise<BillingAccount> {
    throw new Error("not implemented (ac05)");
  },
};
