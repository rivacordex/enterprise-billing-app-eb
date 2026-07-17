import type { z } from "zod";

import {
  contactFieldsSchema,
  contactMediumIdSchema,
} from "@/validation/customer/contact-medium.schema";
import {
  optimisticLockSchema,
  partyRoleIdSchema,
} from "@/validation/customer/party-role.schema";

// Same composition style as `addContactSchema` (cm11) — reuses
// `contactFieldsSchema` verbatim, adding the identifiers an update needs to
// target the right row and the shared optimistic-lock fields (cm08-spec
// §2.2).
export const updateContactSchema = contactFieldsSchema
  .extend({
    contactMediumId: contactMediumIdSchema,
    partyRoleId: partyRoleIdSchema,
  })
  .merge(optimisticLockSchema);
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
