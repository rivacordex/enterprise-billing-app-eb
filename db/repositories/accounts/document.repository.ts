import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { document } from "@/db/schema/billing/documents";
import type { Document, DocumentInsert } from "@/db/schema/billing/documents";
import type { DocType } from "@/types/accounts";

// One dedicated sequence per doc_type (documents.ts) — the documented
// exception to "IDs are a DB-layer column default" (code-standards §6.2),
// since `document_id`'s prefix depends on the sibling `doc_type` value.
const DOC_SEQUENCE_NAME: Record<DocType, string> = {
  PAY: "billing.document_pay_seq",
  DEP: "billing.document_dep_seq",
  CRN: "billing.document_crn_seq",
  DBN: "billing.document_dbn_seq",
  ADJ: "billing.document_adj_seq",
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
};
