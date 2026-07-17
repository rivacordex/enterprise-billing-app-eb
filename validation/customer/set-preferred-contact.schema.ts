import { z } from "zod";

import { contactMediumIdSchema } from "@/validation/customer/contact-medium.schema";
import {
  optimisticLockSchema,
  partyRoleIdSchema,
} from "@/validation/customer/party-role.schema";

// Same composition style as `deleteContactSchema` (cm13) — only the two
// identifiers this action needs to target the reassignment plus the shared
// optimistic-lock fields. No contact fields — nothing is being written to
// them.
export const setPreferredContactSchema = z
  .object({
    contactMediumId: contactMediumIdSchema,
    partyRoleId: partyRoleIdSchema,
  })
  .merge(optimisticLockSchema);
export type SetPreferredContactInput = z.infer<
  typeof setPreferredContactSchema
>;
