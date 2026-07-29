import { z } from "zod";

import {
  documentIdSchema,
  documentLockSchema,
} from "@/validation/accounts/document-base.schema";

export const approveDocumentSchema = z.object({
  documentId: documentIdSchema,
  ...documentLockSchema.shape,
});

export type ApproveDocumentInput = z.infer<typeof approveDocumentSchema>;
