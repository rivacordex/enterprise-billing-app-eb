import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";

// The **only** wrapper over `pgledger_create_account` /
// `pgledger_create_transfer(s)` and the three pgledger views (Module Inv.
// #3/#4, code-standards §6.3) — no other repository in this module or
// elsewhere may call these functions or select from the underlying
// `pgledger_*` tables.
export const ledgerRepository = {
  async findByName(tx: Database, name: string): Promise<{ id: string } | null> {
    const [row] = await tx.execute<{ id: string }>(
      sql`SELECT id FROM billing.pgledger_accounts_view WHERE name = ${name} LIMIT 1`,
    );
    return row ? { id: row.id } : null;
  },

  async createAccount(
    tx: Database,
    name: string,
    currency: string,
  ): Promise<{ id: string }> {
    const [row] = await tx.execute<{ id: string }>(
      sql`SELECT id FROM billing.pgledger_create_account(${name}, ${currency})`,
    );
    if (!row) {
      throw new Error(
        `pgledger_create_account returned no row for account '${name}'`,
      );
    }
    return { id: row.id };
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
