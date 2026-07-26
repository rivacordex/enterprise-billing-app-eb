import type { Database } from "@/db/client";
import type { Document } from "@/db/schema/billing/documents";
import type { DocType } from "@/types/accounts";

// Skeleton (ac02-spec §2.6/§3.5). `document_id` has no column default
// (§2.2) — the future `insert` here is the documented exception that
// assembles the id itself, by selecting `nextval` for the row's `doc_type`
// from `document_pay_seq`/`document_dep_seq`/`document_crn_seq`/
// `document_dbn_seq`/`document_adj_seq` (declared in
// `db/schema/billing/documents.ts`). Filled by ac07 (document core).
export const documentRepository = {
  async findById(_db: Database, _documentId: string): Promise<Document | null> {
    throw new Error("not implemented (ac07)");
  },

  async insert(
    _tx: Database,
    _docType: DocType,
    _data: Omit<Document, "documentId" | "docType">,
  ): Promise<Document> {
    throw new Error("not implemented (ac07)");
  },
};
