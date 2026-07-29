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

  // ac06-spec §2.5 — the reverse lookup `resolveLedgerAccountLabel` needs:
  // a pgledger account id back to its TMF owner (ban.*/fa.* only; sys.*
  // accounts have no binding row).
  async findByPgledgerAccountId(
    db: Database,
    pgledgerAccountId: string,
  ): Promise<LedgerBinding | null> {
    const [row] = await db
      .select()
      .from(ledgerBinding)
      .where(eq(ledgerBinding.pgledgerAccountId, pgledgerAccountId))
      .limit(1);
    return row ?? null;
  },
};
