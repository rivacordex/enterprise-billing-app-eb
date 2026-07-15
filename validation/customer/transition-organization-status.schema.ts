import { z } from "zod";

import { ORGANIZATION_STATUSES } from "@/types/customer";
import { organizationIdSchema } from "@/validation/customer/organization.schema";
import {
  partyRoleIdSchema,
  statusTransitionInputSchema,
} from "@/validation/customer/party-role.schema";

// `targetStatus` merely has to be a member of the enum here — the actual
// edge-validity check (is this status reachable from the current one) is
// the service's job against `ORGANIZATION_TRANSITIONS`, not this schema's
// (cm09-spec §3.2).
export const transitionOrganizationStatusSchema = z
  .object({
    organizationId: organizationIdSchema,
    partyRoleId: partyRoleIdSchema,
    targetStatus: z.enum(ORGANIZATION_STATUSES),
  })
  .merge(statusTransitionInputSchema);
export type TransitionOrganizationStatusInput = z.infer<
  typeof transitionOrganizationStatusSchema
>;
