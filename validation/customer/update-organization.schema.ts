import type { z } from "zod";

import {
  optimisticLockSchema,
  partyRoleIdSchema,
} from "@/validation/customer/party-role.schema";
import {
  organizationFieldsSchema,
  organizationIdSchema,
} from "@/validation/customer/organization.schema";

// Reuses `organizationFieldsSchema` verbatim (cm02) and merges the shared
// `optimisticLockSchema` (cm08-spec §2.2) — the value the page loaded,
// submitted back unchanged, compared server-side by `compareAndBumpLock`.
export const updateOrganizationSchema = organizationFieldsSchema
  .extend({
    organizationId: organizationIdSchema,
    partyRoleId: partyRoleIdSchema,
  })
  .merge(optimisticLockSchema);
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
