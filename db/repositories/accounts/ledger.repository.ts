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

  // Balance for a single pgledger account (Module Inv. #2 — read path).
  // Returns the balance string (may be "0.00") when the account exists, or
  // null when no row is found (mirrors findByName not-found behaviour).
  async balanceByLedgerAccountId(
    db: Database,
    pgledgerAccountId: string,
  ): Promise<string | null> {
    const [row] = await db.execute<{ balance: string }>(
      sql`SELECT balance::text AS balance FROM billing.pgledger_accounts_view WHERE id = ${pgledgerAccountId} LIMIT 1`,
    );
    return row ? (row.balance ?? "0.00") : null;
  },

  // Sum of all receivables balances across every BAN bound to a given FA.
  // (spec §2.4 — "Receivable balance = Σ A/R across the FA's BANs'
  // receivables accounts"). Returns "0.00" when there are no BANs.
  async sumReceivablesForFinancialAccount(
    db: Database,
    financialAccountId: string,
  ): Promise<string> {
    const [row] = await db.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(pav.balance), 0)::text AS total
      FROM billing.billing_account ban
      JOIN billing.ledger_binding lb
        ON lb.owner_type = 'billing_account'
       AND lb.owner_id   = ban.billing_account_id
       AND lb.ledger_role = 'receivables'
      JOIN billing.pgledger_accounts_view pav ON pav.id = lb.pgledger_account_id
      WHERE ban.ref_financial_account_id = ${financialAccountId}
    `);
    return row?.total ?? "0.00";
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
