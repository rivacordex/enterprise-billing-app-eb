import { z } from "zod";

import { organizationFieldsSchema } from "@/validation/customer/organization.schema";

// Reuses `organizationFieldsSchema` verbatim (cm02) — no re-declared field
// shape (code-standards §1.4's spirit). `confirmed` is the two-step
// similar-name confirm flag (cm07-spec §2.2); `specificationRaw` mirrors the
// server's well-formedness-only check via `parseSpecificationInput`.
export const createCustomerSchema = organizationFieldsSchema.extend({
  specificationRaw: z.string().default("{}"),
  confirmed: z.boolean().default(false),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
