import { z } from "zod";

import {
  documentIdSchema,
  documentLockSchema,
} from "@/validation/accounts/document-base.schema";

export const submitDocumentSchema = z
  .object({ documentId: documentIdSchema })
  .merge(documentLockSchema);

export type SubmitDocumentInput = z.infer<typeof submitDocumentSchema>;
