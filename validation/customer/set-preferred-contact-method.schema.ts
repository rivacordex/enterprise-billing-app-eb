import { z } from "zod";

import { contactMediumIdSchema } from "@/validation/customer/contact-medium.schema";
import {
  optimisticLockSchema,
  partyRoleIdSchema,
} from "@/validation/customer/party-role.schema";
import { PREFERRED_CONTACT_METHODS } from "@/types/customer";

// Same composition style as `setPreferredContactSchema` (cm14) — only the
// identifiers this action needs plus the shared optimistic-lock fields.
// `targetMethod` is never nullable (cm15-spec §2.1.1) — there is no
// "explicit clear" verb in this module.
export const setPreferredContactMethodSchema = z
  .object({
    contactMediumId: contactMediumIdSchema,
    partyRoleId: partyRoleIdSchema,
    targetMethod: z.enum(PREFERRED_CONTACT_METHODS),
  })
  .merge(optimisticLockSchema);
export type SetPreferredContactMethodInput = z.infer<
  typeof setPreferredContactMethodSchema
>;
