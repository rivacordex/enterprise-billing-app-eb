import { z } from "zod";

import { contactMediumIdSchema } from "@/validation/customer/contact-medium.schema";
import {
  optimisticLockSchema,
  partyRoleIdSchema,
} from "@/validation/customer/party-role.schema";

// Same composition style as `updateContactSchema` (cm12) — only the two
// identifiers a delete needs to target the right row plus the shared
// optimistic-lock fields (cm08-spec §2.2). No contact fields — nothing is
// being written to them.
export const deleteContactSchema = z
  .object({
    contactMediumId: contactMediumIdSchema,
    partyRoleId: partyRoleIdSchema,
  })
  .merge(optimisticLockSchema);
export type DeleteContactInput = z.infer<typeof deleteContactSchema>;
