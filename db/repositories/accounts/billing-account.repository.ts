import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billingAccount } from "@/db/schema/billing/accounts";
import type {
  BillingAccount,
  BillingAccountInsert,
} from "@/db/schema/billing/accounts";

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
    tx: Database,
    data: BillingAccountInsert,
  ): Promise<BillingAccount> {
    const [row] = await tx.insert(billingAccount).values(data).returning();
    if (!row) throw new Error("billing_account insert returned no row");
    return row;
  },

  // The `payment_status` write path (ac07-spec §2.7, V8) — flips between
  // `paid`/`due` on allocation posting. `overdue` is never written here; it
  // stays a read-time derivation (Q8, ac05's badge).
  async updatePaymentStatus(
    tx: Database,
    billingAccountId: string,
    paymentStatus: "paid" | "due",
  ): Promise<void> {
    await tx
      .update(billingAccount)
      .set({ paymentStatus })
      .where(eq(billingAccount.billingAccountId, billingAccountId));
  },
};
