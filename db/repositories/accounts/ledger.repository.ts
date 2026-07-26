import type { Database } from "@/db/client";

// Skeleton (ac02-spec §2.6/§3.5). The **only** wrapper over
// `pgledger_create_account` / `pgledger_create_transfer(s)` and the three
// pgledger views (Module Inv. #3/#4, code-standards §6.3) — no other
// repository in this module or elsewhere may call these functions or select
// from the underlying `pgledger_*` tables. Filled by ac05 (account
// creation) and ac07 (transfer creation at post time).
export const ledgerRepository = {
  async createAccount(
    _tx: Database,
    _name: string,
    _currency: string,
  ): Promise<{ id: string }> {
    throw new Error("not implemented (ac05)");
  },

  async createTransfer(
    _tx: Database,
    _fromAccountId: string,
    _toAccountId: string,
    _amount: string,
    _eventAt: Date,
    _metadata: Record<string, unknown>,
  ): Promise<{ id: string }> {
    throw new Error("not implemented (ac07)");
  },
};
