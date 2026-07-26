import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billingAccount } from "@/db/schema/billing/accounts";
import type {
  BillingAccount,
  BillingAccountInsert,
} from "@/db/schema/billing/accounts";

// Skeleton (ac02-spec §2.6/§3.5) — only `findById` is real; every mutation
// is a later unit's onboarding/servicing use case.
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
    void _tx;
    void _data;
    throw new Error(
      "not implemented — filled in by the customer-onboarding accounts unit",
    );
  },
};
