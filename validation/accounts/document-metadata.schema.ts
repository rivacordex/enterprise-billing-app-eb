import { z } from "zod";

// `document.metadata` jsonb — the documented exemption (code-standards §6.5):
// well-formed JSON plus reserved-key typing only. `doc` and `dim_*` (Q25
// escrow) are reserved; every other key passes through untyped.
export const documentMetadataSchema = z
  .object({
    doc: z.string().optional(),
  })
  .catchall(z.unknown());
export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;
