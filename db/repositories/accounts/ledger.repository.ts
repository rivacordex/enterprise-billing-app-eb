import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import type { LEDGER_TRANSFER_SORT_VALUES } from "@/validation/accounts/ledger-explorer-search-params.schema";

export type LedgerTransferSort = (typeof LEDGER_TRANSFER_SORT_VALUES)[number];

export type LedgerAccountRow = {
  id: string;
  name: string;
  currency: string;
  balance: string;
};

export type LedgerTransferFilters = {
  eventFrom: Date | null;
  eventTo: Date | null;
  metadataQuery: string;
  sort: LedgerTransferSort;
  page: number;
  pageSize: number;
};

export type LedgerTransferRow = {
  id: string;
  fromAccountId: string;
  fromAccountName: string;
  toAccountId: string;
  toAccountName: string;
  amount: string;
  eventAt: Date;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
};

export type LedgerEntryRow = {
  id: string;
  accountId: string;
  accountName: string;
  amount: string;
  accountPreviousBalance: string;
  accountCurrentBalance: string;
};

// Sort key → deterministic ORDER BY fragment (ac06-spec §2.2 — sort is a URL
// param so a future export matches on-screen order). `t.id` tie-breaker
// keeps pagination stable. Fully baked from the validated `sort` enum, never
// from raw user input, so this is safe to splice into raw SQL.
const TRANSFER_ORDER_CLAUSES: Record<
  LedgerTransferSort,
  ReturnType<typeof sql>
> = {
  event_at: sql`t.event_at ASC, t.id ASC`,
  "-event_at": sql`t.event_at DESC, t.id DESC`,
  created_at: sql`t.created_at ASC, t.id ASC`,
  "-created_at": sql`t.created_at DESC, t.id DESC`,
  amount: sql`t.amount ASC, t.id ASC`,
  "-amount": sql`t.amount DESC, t.id DESC`,
};

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
      // Cast to numeric(18,2) so a zero/unscaled balance serialises as "0.00",
      // not "0" — the module's money strings are always 2 dp (code-standards
      // §2.2), matching this method's own "0.00" default below.
      sql`SELECT balance::numeric(18,2)::text AS balance FROM billing.pgledger_accounts_view WHERE id = ${pgledgerAccountId} LIMIT 1`,
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
      SELECT COALESCE(SUM(pav.balance), 0)::numeric(18,2)::text AS total
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

  // The sole caller-facing entry point onto `pgledger_create_transfers`
  // (ac07-spec §3.9, code-standards §1.1/§6.3) — `post-document.ts` is the
  // only service that calls this. One call posts every leg of a document
  // atomically: all involved accounts are locked in a stable order inside
  // the function itself (deadlock-safe), and the whole batch commits or
  // rolls back together. `metadata` is shared across every leg in the batch
  // (the function has no per-leg metadata parameter) — every call site
  // passes `{ doc: documentId }` (Module Inv. #3's both-way trace).
  //
  // Row order: the upstream function's final `SELECT ... ORDER BY id` sorts
  // by the ULID primary key, which pgledger generates time-ordered — since
  // every leg in one call is inserted in a single sequential loop, this
  // reliably reproduces the input array's order. Callers zip the returned
  // rows back onto their input legs by index on that basis.
  async pgledgerCreateTransfers(
    tx: Database,
    legs: { fromAccountId: string; toAccountId: string; amount: string }[],
    eventAt: Date,
    metadata: Record<string, unknown>,
  ): Promise<{ id: string }[]> {
    if (legs.length === 0) {
      throw new Error("pgledgerCreateTransfers requires at least one leg");
    }
    const legFragments = legs.map(
      (leg) =>
        sql`(${leg.fromAccountId}, ${leg.toAccountId}, ${leg.amount}::numeric)::billing.transfer_request`,
    );
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM billing.pgledger_create_transfers(
        ARRAY[${sql.join(legFragments, sql`, `)}],
        ${eventAt.toISOString()}::timestamptz,
        ${JSON.stringify(metadata)}::jsonb
      )
    `);
    return rows.map((r) => ({ id: r.id }));
  },

  // ac06-spec §2.1 — account picker: resolves any pgledger account by its
  // `ban.*`/`fa.*`/`sys.*` name.
  async searchAccountsByName(
    db: Database,
    query: string,
    limit: number,
  ): Promise<LedgerAccountRow[]> {
    const pattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
    return db.execute<LedgerAccountRow>(sql`
      SELECT id, name, currency, balance::text AS balance
      FROM billing.pgledger_accounts_view
      WHERE name ILIKE ${pattern}
      ORDER BY name
      LIMIT ${limit}
    `);
  },

  async findAccountById(
    db: Database,
    id: string,
  ): Promise<LedgerAccountRow | null> {
    const [row] = await db.execute<LedgerAccountRow>(sql`
      SELECT id, name, currency, balance::text AS balance
      FROM billing.pgledger_accounts_view
      WHERE id = ${id}
      LIMIT 1
    `);
    return row ?? null;
  },

  // ac06-spec §2.2 — the transfers grid: `accountId` matches either leg
  // (from OR to), filtered by `event_at` range + a single metadata search
  // across `doc`/`ban`/`type`, server-paginated, URL-driven sort.
  async listTransfersForAccount(
    db: Database,
    accountId: string,
    filters: LedgerTransferFilters,
  ): Promise<{ rows: LedgerTransferRow[]; total: number }> {
    const metaPattern = filters.metadataQuery
      ? `%${filters.metadataQuery.replace(/[%_\\]/g, "\\$&")}%`
      : null;

    const whereClause = sql`
      (t.from_account_id = ${accountId} OR t.to_account_id = ${accountId})
      ${filters.eventFrom ? sql`AND t.event_at >= ${filters.eventFrom.toISOString()}` : sql``}
      ${filters.eventTo ? sql`AND t.event_at <= ${filters.eventTo.toISOString()}` : sql``}
      ${
        metaPattern
          ? sql`AND (
              t.metadata->>'doc' ILIKE ${metaPattern}
              OR t.metadata->>'ban' ILIKE ${metaPattern}
              OR t.metadata->>'type' ILIKE ${metaPattern}
            )`
          : sql``
      }
    `;

    const [countRow] = await db.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM billing.pgledger_transfers_view t
      WHERE ${whereClause}
    `);
    const total = Number(countRow?.total ?? 0);

    const offset = (filters.page - 1) * filters.pageSize;
    const rows = await db.execute<{
      id: string;
      from_account_id: string;
      from_account_name: string;
      to_account_id: string;
      to_account_name: string;
      amount: string;
      event_at: Date;
      created_at: Date;
      metadata: Record<string, unknown> | null;
    }>(sql`
      SELECT
        t.id,
        t.from_account_id, fa.name AS from_account_name,
        t.to_account_id,   ta.name AS to_account_name,
        t.amount::text AS amount,
        t.event_at, t.created_at, t.metadata
      FROM billing.pgledger_transfers_view t
      JOIN billing.pgledger_accounts_view fa ON fa.id = t.from_account_id
      JOIN billing.pgledger_accounts_view ta ON ta.id = t.to_account_id
      WHERE ${whereClause}
      ORDER BY ${TRANSFER_ORDER_CLAUSES[filters.sort]}
      LIMIT ${filters.pageSize} OFFSET ${offset}
    `);

    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        fromAccountId: r.from_account_id,
        fromAccountName: r.from_account_name,
        toAccountId: r.to_account_id,
        toAccountName: r.to_account_name,
        amount: r.amount,
        eventAt: r.event_at,
        createdAt: r.created_at,
        metadata: r.metadata,
      })),
    };
  },

  // ac06-spec §2.3 — the transfer-detail drawer's header row.
  async findTransferById(
    db: Database,
    transferId: string,
  ): Promise<LedgerTransferRow | null> {
    const [row] = await db.execute<{
      id: string;
      from_account_id: string;
      from_account_name: string;
      to_account_id: string;
      to_account_name: string;
      amount: string;
      event_at: Date;
      created_at: Date;
      metadata: Record<string, unknown> | null;
    }>(sql`
      SELECT
        t.id,
        t.from_account_id, fa.name AS from_account_name,
        t.to_account_id,   ta.name AS to_account_name,
        t.amount::text AS amount,
        t.event_at, t.created_at, t.metadata
      FROM billing.pgledger_transfers_view t
      JOIN billing.pgledger_accounts_view fa ON fa.id = t.from_account_id
      JOIN billing.pgledger_accounts_view ta ON ta.id = t.to_account_id
      WHERE t.id = ${transferId}
      LIMIT 1
    `);
    if (!row) return null;
    return {
      id: row.id,
      fromAccountId: row.from_account_id,
      fromAccountName: row.from_account_name,
      toAccountId: row.to_account_id,
      toAccountName: row.to_account_name,
      amount: row.amount,
      eventAt: row.event_at,
      createdAt: row.created_at,
      metadata: row.metadata,
    };
  },

  // ac21-spec §2.3 — batch read by a list of transfer IDs; avoids N+1 when a
  // multi-line document needs all its transfers at once. Views only (inv. #4).
  async findTransfersByIds(
    db: Database,
    ids: string[],
  ): Promise<Map<string, LedgerTransferRow>> {
    if (ids.length === 0) return new Map();
    const idList = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await db.execute<{
      id: string;
      from_account_id: string;
      from_account_name: string;
      to_account_id: string;
      to_account_name: string;
      amount: string;
      event_at: Date;
      created_at: Date;
      metadata: Record<string, unknown> | null;
    }>(sql`
      SELECT
        t.id,
        t.from_account_id, fa.name AS from_account_name,
        t.to_account_id,   ta.name AS to_account_name,
        t.amount::text AS amount,
        t.event_at, t.created_at, t.metadata
      FROM billing.pgledger_transfers_view t
      JOIN billing.pgledger_accounts_view fa ON fa.id = t.from_account_id
      JOIN billing.pgledger_accounts_view ta ON ta.id = t.to_account_id
      WHERE t.id = ANY(ARRAY[${idList}])
    `);
    const map = new Map<string, LedgerTransferRow>();
    for (const row of rows) {
      map.set(row.id, {
        id: row.id,
        fromAccountId: row.from_account_id,
        fromAccountName: row.from_account_name,
        toAccountId: row.to_account_id,
        toAccountName: row.to_account_name,
        amount: row.amount,
        eventAt: row.event_at,
        createdAt: row.created_at,
        metadata: row.metadata,
      });
    }
    return map;
  },

  // ac06-spec §2.3 — the two `pgledger_entries_view` legs (debit + credit)
  // for a transfer, with the running previous/current balance columns.
  // Ordered by amount DESC so the debit (positive) leg renders first.
  async findEntriesByTransferId(
    db: Database,
    transferId: string,
  ): Promise<LedgerEntryRow[]> {
    const rows = await db.execute<{
      id: string;
      account_id: string;
      account_name: string;
      amount: string;
      account_previous_balance: string;
      account_current_balance: string;
    }>(sql`
      SELECT
        e.id, e.account_id, a.name AS account_name,
        e.amount::text AS amount,
        e.account_previous_balance::text AS account_previous_balance,
        e.account_current_balance::text AS account_current_balance
      FROM billing.pgledger_entries_view e
      JOIN billing.pgledger_accounts_view a ON a.id = e.account_id
      WHERE e.transfer_id = ${transferId}
      ORDER BY e.amount DESC
    `);
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      accountName: r.account_name,
      amount: r.amount,
      accountPreviousBalance: r.account_previous_balance,
      accountCurrentBalance: r.account_current_balance,
    }));
  },

  // ac12-spec §2.4 — V5 health panel: count of pgledger accounts with no
  // resolved GL code (gl_resolution_view WHERE gl_code IS NULL). Run inside
  // a transaction after a provisional mapping/code change to implement the
  // F5 orphan-block: if the count rises above 0, the caller rolls back.
  async countUnmappedAccounts(db: Database): Promise<number> {
    const [row] = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt
      FROM billing.gl_resolution_view
      WHERE gl_code IS NULL
    `);
    return Number(row?.cnt ?? 0);
  },

  // Companion to countUnmappedAccounts — returns the pgledger account names
  // for the affected-account list shown in the ORPHAN_BLOCK response.
  async findUnmappedAccountNames(db: Database): Promise<string[]> {
    const rows = await db.execute<{ name: string }>(sql`
      SELECT pav.name
      FROM billing.gl_resolution_view grv
      JOIN billing.pgledger_accounts_view pav
        ON pav.id = grv.pgledger_account_id
      WHERE grv.gl_code IS NULL
      ORDER BY pav.name
    `);
    return rows.map((r) => r.name);
  },

  // bm10-spec §Design/§1 — the pre-approval "GL mappings resolvable" check:
  // does a named pgledger account (e.g. `sys.revenue.{ccy}`) resolve to a GL
  // code via `gl_resolution_view`? Returns null both when the account doesn't
  // exist yet and when it exists but is unmapped (`gl_code IS NULL`) — both
  // read as "not resolvable" to the caller; it never distinguishes the two.
  async resolveGlCodeByName(
    db: Database,
    name: string,
  ): Promise<string | null> {
    const [row] = await db.execute<{ gl_code: string | null }>(sql`
      SELECT grv.gl_code
      FROM billing.pgledger_accounts_view pav
      JOIN billing.gl_resolution_view grv ON grv.pgledger_account_id = pav.id
      WHERE pav.name = ${name}
      LIMIT 1
    `);
    return row?.gl_code ?? null;
  },

  // ac06-spec §2.4 — V1 surfaced permanently in the UI: Σ balance per
  // currency across every pgledger account.
  async zeroSumByCurrency(
    db: Database,
  ): Promise<{ currency: string; total: string }[]> {
    return db.execute<{ currency: string; total: string }>(sql`
      SELECT currency, COALESCE(SUM(balance), 0)::text AS total
      FROM billing.pgledger_accounts_view
      GROUP BY currency
      ORDER BY currency
    `);
  },
};
