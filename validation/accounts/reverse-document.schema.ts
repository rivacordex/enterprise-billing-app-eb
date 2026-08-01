import { z } from "zod";

import {
  documentBaseSchema,
  documentIdSchema,
  documentLockSchema,
} from "@/validation/accounts/document-base.schema";

// ac11-spec §3.3 — shared schema for both document-level and line-level
// reversal (the action routes based on `selectedLineIds` presence). Merges
// ac07's `documentBaseSchema` (Q29 mandatory date trio) and
// `documentLockSchema` (CAS on the original document's `lastModified`).
//
// `selectedLineIds`: if present (non-empty array), only those lines are
// reversed (line-level, Q5 allocation-line case). If absent or empty, every
// posted unreversed line of the original document is reversed (document-
// level). The service rejects already-reversed lines in either path.
export const reverseDocumentSchema = documentBaseSchema
  .merge(documentLockSchema)
  .extend({
    originalDocumentId: documentIdSchema,
    // The FA the document must belong to — validated server-side (Q1 ownership
    // guard, same pattern as raise-credit-note/raise-debit-note).
    financialAccountId: z.string().min(1),
    selectedLineIds: z.array(z.string().min(1)).optional(),
    reversalComment: z
      .string()
      .trim()
      .min(1, "Reversal comment is required")
      .max(500),
  });

export type ReverseDocumentInput = z.infer<typeof reverseDocumentSchema>;
