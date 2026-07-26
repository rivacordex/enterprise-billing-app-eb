import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";

// The sole wrapper over pgledger functions/views (module Inv. #3/#4,
// code-standards §6.3) — every other repository/service reaches the ledger
// only through this file. No Drizzle table objects back these methods —
// `billing.pgledger_*` sits outside the Drizzle schema surface entirely
// (ac01's raw-SQL fork), so real implementations here issue raw SQL
// (`sql\`SELECT * FROM billing.pgledger_create_account(...)\``), never an
// ORM table reference.
export interface PgledgerAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
  version: number;
  allow_negative_balance: boolean;
  allow_positive_balance: boolean;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export const ledgerRepository = {
  // First real caller: ac03's sys-account seed (§2.2 — idempotent-by-name
  // creation of the six `sys.{nature}.MYR` accounts). Document posting
  // (createTransfer(s) below) remains a later unit.
  async createAccount(
    tx: Database,
    params: {
      name: string;
      currency: string;
      allowNegativeBalance?: boolean;
      allowPositiveBalance?: boolean;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<PgledgerAccount> {
    const metadataJson =
      params.metadata !== undefined && params.metadata !== null
        ? JSON.stringify(params.metadata)
        : null;

    const rows = (await tx.execute(sql`
      SELECT * FROM billing.pgledger_create_account(
        ${params.name},
        ${params.currency},
        ${params.allowNegativeBalance ?? true},
        ${params.allowPositiveBalance ?? true},
        ${metadataJson}::jsonb
      )
    `)) as unknown as PgledgerAccount[];

    const [row] = rows;
    if (!row) {
      throw new Error(
        `pgledger_create_account('${params.name}') returned no row.`,
      );
    }
    return row;
  },

  // Idempotent-by-name lookups (sys accounts have no natural-key table of
  // their own — `pgledger_accounts_view.name` is the natural key, §2.2).
  async findByName(
    db: Database,
    name: string,
  ): Promise<PgledgerAccount | null> {
    const rows = (await db.execute(sql`
      SELECT * FROM billing.pgledger_accounts_view WHERE name = ${name} LIMIT 1
    `)) as unknown as PgledgerAccount[];
    return rows[0] ?? null;
  },

  async createTransfer(
    _tx: Database,
    _params: {
      fromAccountId: string;
      toAccountId: string;
      amount: string;
      eventAt: Date;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: string }> {
    void _tx;
    void _params;
    throw new Error("not implemented — filled in by the document-posting unit");
  },

  async createTransfers(
    _tx: Database,
    _params: Array<{
      fromAccountId: string;
      toAccountId: string;
      amount: string;
      eventAt: Date;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<Array<{ id: string }>> {
    void _tx;
    void _params;
    throw new Error("not implemented — filled in by the document-posting unit");
  },
};
