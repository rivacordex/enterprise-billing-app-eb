import type { z } from "zod";

import { contactFieldsSchema } from "@/validation/customer/contact-medium.schema";
import {
  optimisticLockSchema,
  partyRoleIdSchema,
} from "@/validation/customer/party-role.schema";

// Reuses `contactFieldsSchema` verbatim (cm02) and merges the shared
// `optimisticLockSchema` (cm08-spec §2.2) — same composition style as
// `updateOrganizationSchema`. No cross-field "at least one method" refine —
// a name-only contact is a valid state (cm11-spec §2.6.3).
export const addContactSchema = contactFieldsSchema
  .extend({
    partyRoleId: partyRoleIdSchema,
  })
  .merge(optimisticLockSchema);
export type AddContactInput = z.infer<typeof addContactSchema>;
