import { z } from "zod";

import {
  optimisticLockSchema,
  partyRoleIdSchema,
} from "@/validation/customer/party-role.schema";

// `specificationRaw` mirrors `CreateCustomerInput`'s field of the same name
// (cm07) — the well-formedness-only check happens server-side via
// `parseSpecificationInput`, not here (cm10-spec §3.2).
export const updatePartyRoleSpecificationSchema = z
  .object({
    partyRoleId: partyRoleIdSchema,
    specificationRaw: z.string(),
  })
  .merge(optimisticLockSchema);
export type UpdatePartyRoleSpecificationInput = z.infer<
  typeof updatePartyRoleSpecificationSchema
>;
