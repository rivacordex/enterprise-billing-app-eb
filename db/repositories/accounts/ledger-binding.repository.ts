import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { ledgerBinding } from "@/db/schema/billing/ledger-binding";
import type {
  LedgerBinding,
  LedgerBindingInsert,
} from "@/db/schema/billing/ledger-binding";

// Skeleton (ac02-spec §2.6/§3.5) — only `findById` is real; binding creation
// is the customer-onboarding accounts unit (module Inv. #9).
export const ledgerBindingRepository = {
  async findById(
    db: Database,
    ledgerBindingId: string,
  ): Promise<LedgerBinding | null> {
    const [row] = await db
      .select()
      .from(ledgerBinding)
      .where(eq(ledgerBinding.ledgerBindingId, ledgerBindingId))
      .limit(1);
    return row ?? null;
  },

  async insert(
    _tx: Database,
    _data: LedgerBindingInsert,
  ): Promise<LedgerBinding> {
    void _tx;
    void _data;
    throw new Error(
      "not implemented — filled in by the customer-onboarding accounts unit",
    );
  },
};
