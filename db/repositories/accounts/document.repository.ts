import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { document, documentLine } from "@/db/schema/billing/documents";
import type {
  Document,
  DocumentInsert,
  DocumentLine,
} from "@/db/schema/billing/documents";
import type { DocType } from "@/types/accounts";

// Skeleton (ac02-spec §2.6/§3.5) — only the two `findById` readers are real;
// posting (`services/accounts/post-document.ts`, module Inv. #1/#5) is a
// later unit.
export const documentRepository = {
  async findById(db: Database, documentId: string): Promise<Document | null> {
    const [row] = await db
      .select()
      .from(document)
      .where(eq(document.documentId, documentId))
      .limit(1);
    return row ?? null;
  },

  async findLinesByDocumentId(
    db: Database,
    documentId: string,
  ): Promise<DocumentLine[]> {
    return db
      .select()
      .from(documentLine)
      .where(eq(documentLine.refDocumentId, documentId));
  },

  // The `document_id` per-type sequence assembler seam (§2.2): `document_id`
  // has no column default because a default expression can't switch on the
  // row's own `doc_type`, so this insert must select `nextval` for the right
  // one of the five `document_<type>_seq` sequences and assemble
  // `<PREFIX><padded>` itself before the INSERT. Left unimplemented here —
  // the first writer (posting unit) fills this in; do not add a column
  // default to `document_id` instead.
  async insert(
    _tx: Database,
    _data: DocumentInsert & { docType: DocType },
  ): Promise<Document> {
    void _tx;
    void _data;
    throw new Error("not implemented — filled in by the document-posting unit");
  },
};
