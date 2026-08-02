// ac13-spec §3.3 — repository reads over gl_journal_view (period summary) and
// pgledger_entries_view (drill-down). No writes — this is a read-only reporting
// surface. Module Inv. #4: pgledger views only, never direct table DML.

import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";

export const GL_JOURNAL_SORT_VALUES = [
  "gl_code",
  "-gl_code",
  "debit",
  "-debit",
  "credit",
  "-credit",
] as const;
export type GlJournalSort = (typeof GL_JOURNAL_SORT_VALUES)[number];

// Movement-branch ORDER BY: debit/credit columns in gl_journal_view are
// numeric, so a direct ::numeric cast is a no-op but keeps the map symmetric.
const SORT_ORDER: Record<GlJournalSort, ReturnType<typeof sql>> = {
  gl_code: sql`gl_code ASC`,
  "-gl_code": sql`gl_code DESC`,
  debit: sql`debit::numeric ASC NULLS LAST, gl_code ASC`,
  "-debit": sql`debit::numeric DESC NULLS LAST, gl_code ASC`,
  credit: sql`credit::numeric ASC NULLS LAST, gl_code ASC`,
  "-credit": sql`credit::numeric DESC NULLS LAST, gl_code ASC`,
};

// Trial-balance branch ORDER BY: the query uses SUM(debit)/SUM(credit)
// aggregate expressions aliased as text. Reference them as aggregate
// expressions explicitly to avoid any ambiguity with the view column names.
const SORT_ORDER_AGGREGATED: Record<GlJournalSort, ReturnType<typeof sql>> = {
  gl_code: sql`gl_code ASC`,
  "-gl_code": sql`gl_code DESC`,
  debit: sql`(SUM(debit))::numeric ASC NULLS LAST, gl_code ASC`,
  "-debit": sql`(SUM(debit))::numeric DESC NULLS LAST, gl_code ASC`,
  credit: sql`(SUM(credit))::numeric ASC NULLS LAST, gl_code ASC`,
  "-credit": sql`(SUM(credit))::numeric DESC NULLS LAST, gl_code ASC`,
};

// Maximum drill-down rows returned. Fetching CAP + 1 lets the service detect
// truncation without a separate COUNT query.
export const DRILLDOWN_CAP = 500;

export type GlJournalSummaryRow = {
  glCode: string;
  name: string;
  debit: string;
  credit: string;
};

export type GlJournalEntryRow = {
  entryId: string;
  accountId: string;
  accountName: string;
  amount: string;
  eventAt: Date;
  docId: string | null;
};

export const glJournalRepository = {
  // ac13-spec §2.2/§3.2 — period summary for both view modes:
  //   movement  → entries within the period only (WHERE period = 'YYYY-MM')
  //   trial     → cumulative-to-date (WHERE period <= 'YYYY-MM', re-aggregated)
  // Both use gl_journal_view per spec §2.4.
  async listSummary(
    db: Database,
    period: string,
    view: "movement" | "trial",
    sort: GlJournalSort,
  ): Promise<GlJournalSummaryRow[]> {
    if (view === "movement") {
      const orderBy = SORT_ORDER[sort];
      const rows = await db.execute<{
        gl_code: string;
        name: string;
        debit: string;
        credit: string;
      }>(sql`
        SELECT gl_code, name, debit::text AS debit, credit::text AS credit
        FROM billing.gl_journal_view
        WHERE period = ${period}
        ORDER BY ${orderBy}
      `);
      return rows.map((r) => ({
        glCode: r.gl_code,
        name: r.name,
        debit: r.debit,
        credit: r.credit,
      }));
    }

    // Trial-balance cumulative: sum across all periods ≤ target. Uses the
    // aggregated sort map so ordering is over the aggregate output aliases,
    // not the underlying view columns.
    const orderBy = SORT_ORDER_AGGREGATED[sort];
    const rows = await db.execute<{
      gl_code: string;
      name: string;
      debit: string;
      credit: string;
    }>(sql`
      SELECT gl_code, name,
        SUM(debit)::text  AS debit,
        SUM(credit)::text AS credit
      FROM billing.gl_journal_view
      WHERE period <= ${period}
      GROUP BY gl_code, name
      ORDER BY ${orderBy}
    `);
    return rows.map((r) => ({
      glCode: r.gl_code,
      name: r.name,
      debit: r.debit,
      credit: r.credit,
    }));
  },

  // ac13-spec §2.3/§3.2 — drill-down: all pgledger entries resolved to a
  // given GL code for the scope (movement or cumulative). Joins
  // pgledger_entries_view → gl_resolution_view → pgledger_transfers_view for
  // the doc reference (Module Inv. #3 trace chain).
  // Returns at most DRILLDOWN_CAP entries; truncated: true when more exist.
  async listDrilldown(
    db: Database,
    glCode: string,
    period: string,
    view: "movement" | "trial",
  ): Promise<{ entries: GlJournalEntryRow[]; truncated: boolean }> {
    const periodClause =
      view === "movement"
        ? sql`AND to_char(pev.event_at, 'YYYY-MM') = ${period}`
        : sql`AND to_char(pev.event_at, 'YYYY-MM') <= ${period}`;

    const rows = await db.execute<{
      entry_id: string;
      account_id: string;
      account_name: string;
      amount: string;
      event_at: Date;
      doc_id: string | null;
    }>(sql`
      SELECT
        pev.id          AS entry_id,
        pev.account_id,
        pav.name        AS account_name,
        pev.amount::text AS amount,
        pev.event_at,
        pt.metadata->>'doc' AS doc_id
      FROM billing.pgledger_entries_view pev
      JOIN billing.gl_resolution_view grv
        ON grv.pgledger_account_id = pev.account_id
      JOIN billing.pgledger_accounts_view pav
        ON pav.id = pev.account_id
      JOIN billing.pgledger_transfers_view pt
        ON pt.id = pev.transfer_id
      WHERE grv.gl_code = ${glCode}
      ${periodClause}
      ORDER BY pev.event_at, pev.id
      LIMIT ${DRILLDOWN_CAP + 1}
    `);

    const truncated = rows.length > DRILLDOWN_CAP;
    const entries = rows.slice(0, DRILLDOWN_CAP).map((r) => ({
      entryId: r.entry_id,
      accountId: r.account_id,
      accountName: r.account_name,
      amount: r.amount,
      eventAt: r.event_at,
      docId: r.doc_id,
    }));

    return { entries, truncated };
  },
};
