import { and, asc, eq, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import { document, documentLine } from "@/db/schema/billing/documents";
import type {
  Document,
  DocumentLine,
  DocumentLineInsert,
} from "@/db/schema/billing/documents";

export const documentLineRepository = {
  async insert(
    tx: Database,
    data: Omit<DocumentLineInsert, "documentLineId">,
  ): Promise<DocumentLine> {
    const [row] = await tx.insert(documentLine).values(data).returning();
    if (!row) throw new Error("document_line insert returned no row");
    return row;
  },

  async findById(
    db: Database,
    documentLineId: string,
  ): Promise<DocumentLine | null> {
    const [row] = await db
      .select()
      .from(documentLine)
      .where(eq(documentLine.documentLineId, documentLineId))
      .limit(1);
    return row ?? null;
  },

  async findByDocumentId(
    db: Database,
    documentId: string,
  ): Promise<DocumentLine[]> {
    return db
      .select()
      .from(documentLine)
      .where(eq(documentLine.refDocumentId, documentId))
      .orderBy(asc(documentLine.lineNo));
  },

  // Stamps the 1:1 line↔transfer link at post time (Module Inv. #3/#7,
  // `pgledger_transfer_id UNIQUE`) — the only writer of this column.
  async setTransferId(
    tx: Database,
    documentLineId: string,
    pgledgerTransferId: string,
  ): Promise<void> {
    await tx
      .update(documentLine)
      .set({ pgledgerTransferId })
      .where(eq(documentLine.documentLineId, documentLineId));
  },

  // Posted, not-yet-reversed `allocation` lines for a BAN — the refund
  // workbench's "assigned items" (ac07-spec §2.4b), joined back to their
  // parent document for `eventAt` display.
  async findAllocationsForBillingAccount(
    db: Database,
    billingAccountId: string,
  ): Promise<{ line: DocumentLine; document: Document }[]> {
    const rows = await db
      .select({ line: documentLine, document })
      .from(documentLine)
      .innerJoin(document, eq(documentLine.refDocumentId, document.documentId))
      .where(
        and(
          eq(documentLine.refBillingAccountId, billingAccountId),
          eq(documentLine.lineKind, "allocation"),
          eq(document.state, "posted"),
          isNull(documentLine.reversedByLineId),
        ),
      )
      .orderBy(asc(documentLine.lastModified));
    return rows;
  },

  // Marks an original line as settled by a reversal (the refund workbench's
  // allocation-reversal link, ac07-spec §2.4b) — guards against refunding
  // the same allocation line twice.
  async setReversedByLineId(
    tx: Database,
    documentLineId: string,
    reversedByLineId: string,
  ): Promise<void> {
    await tx
      .update(documentLine)
      .set({ reversedByLineId })
      .where(eq(documentLine.documentLineId, documentLineId));
  },
};
