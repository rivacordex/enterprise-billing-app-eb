import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { ledgerBinding } from "@/db/schema/billing/ledger-binding";
import type {
  LedgerBinding,
  LedgerBindingInsert,
} from "@/db/schema/billing/ledger-binding";

export const ledgerBindingRepository = {
  async findByOwner(
    db: Database,
    ownerType: "financial_account" | "billing_account",
    ownerId: string,
  ): Promise<LedgerBinding[]> {
    return db
      .select()
      .from(ledgerBinding)
      .where(
        and(
          eq(ledgerBinding.ownerType, ownerType),
          eq(ledgerBinding.ownerId, ownerId),
        ),
      );
  },

  async insert(
    tx: Database,
    data: LedgerBindingInsert,
  ): Promise<LedgerBinding> {
    const [row] = await tx.insert(ledgerBinding).values(data).returning();
    if (!row) throw new Error("ledger_binding insert returned no row");
    return row;
  },
};
