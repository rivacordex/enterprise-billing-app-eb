import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { document } from "@/db/schema/billing/documents";
import type { Document, DocumentInsert } from "@/db/schema/billing/documents";
import type { DocType, DocState, DocumentListRow } from "@/types/accounts";
import type { TransactionDocumentSort } from "@/validation/accounts/transactions-search-params.schema";

// One dedicated sequence per doc_type (documents.ts) — the documented
// exception to "IDs are a DB-layer column default" (code-standards §6.2),
// since `document_id`'s prefix depends on the sibling `doc_type` value.
const DOC_SEQUENCE_NAME: Record<DocType, string> = {
  PAY: "billing.document_pay_seq",
  DEP: "billing.document_dep_seq",
  CRN: "billing.document_crn_seq",
  DBN: "billing.document_dbn_seq",
  ADJ: "billing.document_adj_seq",
  INV: "billing.document_inv_seq",
};

export const documentRepository = {
  async findById(db: Database, documentId: string): Promise<Document | null> {
    const [row] = await db
      .select()
      .from(document)
      .where(eq(document.documentId, documentId))
      .limit(1);
    return row ?? null;
  },

  // The Transactions page's "Pending approvals" list (ac07-spec §2.5) — every
  // `pending_approval` document against the selected FA, oldest first.
  async findPendingApprovalsForFinancialAccount(
    db: Database,
    financialAccountId: string,
  ): Promise<Document[]> {
    return db
      .select()
      .from(document)
      .where(
        and(
          eq(document.refFinancialAccountId, financialAccountId),
          eq(document.state, "pending_approval"),
        ),
      )
      .orderBy(asc(document.lastModified));
  },

  async insert(
    tx: Database,
    docType: DocType,
    data: Omit<DocumentInsert, "documentId" | "docType">,
  ): Promise<Document> {
    const [seqRow] = await tx.execute<{ nextval: string }>(
      sql`SELECT nextval(${DOC_SEQUENCE_NAME[docType]}::regclass) AS nextval`,
    );
    if (!seqRow) {
      throw new Error(`nextval(${DOC_SEQUENCE_NAME[docType]}) returned no row`);
    }
    const documentId = `${docType}${seqRow.nextval.padStart(8, "0")}`;

    const [row] = await tx
      .insert(document)
      .values({ ...data, documentId, docType })
      .returning();
    if (!row) throw new Error("document insert returned no row");
    return row;
  },

  // The one place a document's `state`/`approvedBy`/`postedAt` transition is
  // written (document-state-machine.ts, post-document.ts) — a single atomic
  // `UPDATE ... WHERE last_modified = $expected` (code-standards §2.5),
  // matching `partyRoleRepository.compareAndUpdateStatus`'s convention. Zero
  // rows matched (stale lock or unknown id) returns `null`; every caller
  // maps that to `CONFLICT`.
  // ac14-spec §3.4/§3.6 — update event_at on a draft document so the operator
  // can correct a rejected entry date (PERIOD_CLOSED re-date flow, spec §2.2).
  // CAS on lastModified; only updates draft-state rows. Returns null on a stale
  // lock (caller maps to CONFLICT) or when the document isn't in draft state.
  async updateEventAt(
    tx: Database,
    documentId: string,
    expectedLastModified: Date,
    newEventAt: Date,
    actorId: string,
  ): Promise<Document | null> {
    const bumpedLastModified = new Date(
      Math.max(Date.now(), expectedLastModified.getTime() + 1),
    );
    const [row] = await tx
      .update(document)
      .set({
        eventAt: newEventAt,
        lastModified: bumpedLastModified,
        lastEditedBy: actorId,
      })
      .where(
        and(
          eq(document.documentId, documentId),
          eq(document.lastModified, expectedLastModified),
          eq(document.state, "draft"),
        ),
      )
      .returning();
    return row ?? null;
  },

  async compareAndUpdateState(
    tx: Database,
    documentId: string,
    expectedLastModified: Date,
    patch: Partial<Pick<Document, "state" | "approvedBy" | "postedAt">> & {
      lastEditedBy: string;
    },
  ): Promise<Document | null> {
    const bumpedLastModified = new Date(
      Math.max(Date.now(), expectedLastModified.getTime() + 1),
    );
    const [row] = await tx
      .update(document)
      .set({ ...patch, lastModified: bumpedLastModified })
      .where(
        and(
          eq(document.documentId, documentId),
          eq(document.lastModified, expectedLastModified),
        ),
      )
      .returning();
    return row ?? null;
  },

  // ac20-spec §2.2/§3.1 — filterable, paginated document list for the
  // Transactions workbench. One CTE aggregates line counts (for
  // partiallyReversed/reversible derivation in the service); the outer query
  // optionally filters by the derived rev predicate, sorts, and paginates.
  // SELECTs only (inv. #15). Two queries: count then rows (listTransfersForAccount
  // precedent).
  async listForContext(
    db: Database,
    filters: {
      financialAccountId: string;
      billingAccountId: string | null;
      docType: DocType | null;
      state: DocState | null;
      // rev is post-aggregate (derived from line counts) so it lives in the
      // outer WHERE on the CTE — inv. #16 scope predicate is in the CTE WHERE.
      rev: "reversible" | "partial" | null;
      q: string;
      sort: TransactionDocumentSort;
      page: number;
      pageSize: number;
    },
  ): Promise<{ rows: DocumentListRow[]; total: number }> {
    const qTrimmed = filters.q.trim();
    const qPattern = qTrimmed
      ? `%${qTrimmed.replace(/[%_\\]/g, "\\$&")}%`
      : null;

    // inv. #16: BAN predicate admits FA-level docs (refBillingAccountId IS NULL).
    // When no BAN selected, the clause is omitted — FA-wide scope (§2.2).
    const cteWhere = sql`
      d.ref_financial_account_id = ${filters.financialAccountId}
      ${
        filters.billingAccountId
          ? sql`AND (d.ref_billing_account_id = ${filters.billingAccountId} OR d.ref_billing_account_id IS NULL)`
          : sql``
      }
      ${filters.docType ? sql`AND d.doc_type = ${filters.docType}` : sql``}
      ${filters.state ? sql`AND d.state = ${filters.state}` : sql``}
      ${
        qPattern
          ? sql`AND (d.document_id ILIKE ${qPattern} OR d.reason_code ILIKE ${qPattern})`
          : sql``
      }
    `;

    // Outer WHERE for rev filter — applied on the CTE result after aggregation.
    const revWhere =
      filters.rev === "reversible"
        ? sql`AND state = 'posted' AND unreversed_line_count > 0`
        : filters.rev === "partial"
          ? sql`AND state = 'posted' AND unreversed_line_count > 0 AND unreversed_line_count < total_line_count`
          : sql``;

    // Sort clauses reference CTE column aliases. total_amount_num is the
    // numeric column added for correct numeric ordering (text would sort wrong).
    const ORDER_CLAUSES: Record<
      TransactionDocumentSort,
      ReturnType<typeof sql>
    > = {
      event_at: sql`event_at ASC, document_id ASC`,
      "-event_at": sql`event_at DESC, document_id DESC`,
      amount: sql`total_amount_num ASC, document_id ASC`,
      "-amount": sql`total_amount_num DESC, document_id DESC`,
    };
    const orderClause = ORDER_CLAUSES[filters.sort];

    // Count query: minimal CTE columns (state + aggregates) for the rev filter.
    const [countRow] = await db.execute<{ total: string }>(sql`
      WITH agg AS (
        SELECT
          d.document_id,
          d.state,
          COUNT(dl.document_line_id)::int                                            AS total_line_count,
          COUNT(dl.document_line_id) FILTER (WHERE dl.reversed_by_line_id IS NULL)::int AS unreversed_line_count
        FROM billing.document d
        LEFT JOIN billing.document_line dl ON dl.ref_document_id = d.document_id
        WHERE ${cteWhere}
        GROUP BY d.document_id, d.state
      )
      SELECT COUNT(*)::text AS total FROM agg WHERE 1=1 ${revWhere}
    `);
    const total = Number(countRow?.total ?? 0);

    const offset = (filters.page - 1) * filters.pageSize;

    // Data query: full column set + numeric sort proxy.
    const rows = await db.execute<{
      document_id: string;
      doc_type: string;
      state: string;
      ref_financial_account_id: string;
      ref_billing_account_id: string | null;
      reason_code: string;
      currency: string;
      total_amount: string;
      created_by: string;
      approved_by: string | null;
      event_at: Date;
      last_modified: Date;
      total_line_count: number;
      unreversed_line_count: number;
    }>(sql`
      WITH agg AS (
        SELECT
          d.document_id, d.doc_type, d.state,
          d.ref_financial_account_id, d.ref_billing_account_id,
          d.reason_code, d.currency,
          d.total_amount::text        AS total_amount,
          d.total_amount              AS total_amount_num,
          d.created_by, d.approved_by,
          d.event_at, d.last_modified,
          COUNT(dl.document_line_id)::int                                            AS total_line_count,
          COUNT(dl.document_line_id) FILTER (WHERE dl.reversed_by_line_id IS NULL)::int AS unreversed_line_count
        FROM billing.document d
        LEFT JOIN billing.document_line dl ON dl.ref_document_id = d.document_id
        WHERE ${cteWhere}
        GROUP BY
          d.document_id, d.doc_type, d.state,
          d.ref_financial_account_id, d.ref_billing_account_id,
          d.reason_code, d.currency, d.total_amount,
          d.created_by, d.approved_by, d.event_at, d.last_modified
      )
      SELECT
        document_id, doc_type, state,
        ref_financial_account_id, ref_billing_account_id,
        reason_code, currency, total_amount,
        created_by, approved_by, event_at, last_modified,
        total_line_count, unreversed_line_count
      FROM agg
      WHERE 1=1 ${revWhere}
      ORDER BY ${orderClause}
      LIMIT ${filters.pageSize} OFFSET ${offset}
    `);

    return {
      total,
      rows: rows.map((r) => ({
        documentId: r.document_id,
        docType: r.doc_type as DocType,
        state: r.state as DocState,
        refFinancialAccountId: r.ref_financial_account_id,
        refBillingAccountId: r.ref_billing_account_id,
        reasonCode: r.reason_code,
        currency: r.currency,
        totalAmount: r.total_amount,
        createdBy: r.created_by,
        approvedBy: r.approved_by,
        // Coerce to Date: this raw db.execute() bypasses drizzle's column type
        // mapping, so timestamptz arrives as a string — but DocumentListRow
        // types these as Date and formatDatetime() (Intl) throws on a string.
        eventAt: new Date(r.event_at),
        lastModified: new Date(r.last_modified),
        totalLineCount: r.total_line_count,
        unreversedLineCount: r.unreversed_line_count,
      })),
    };
  },
};
