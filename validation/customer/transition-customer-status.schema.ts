import { z } from "zod";

import { CUSTOMER_STATUSES } from "@/types/customer";
import {
  partyRoleIdSchema,
  statusTransitionInputSchema,
} from "@/validation/customer/party-role.schema";

// `targetStatus` merely has to be a member of the enum here — the actual
// edge-validity check (is this status reachable from the current one) is
// the service's job against `CUSTOMER_TRANSITIONS`, not this schema's
// (cm10-spec §3.2, mirroring cm09's `transitionOrganizationStatusSchema`).
export const transitionCustomerStatusSchema = z
  .object({
    partyRoleId: partyRoleIdSchema,
    targetStatus: z.enum(CUSTOMER_STATUSES),
  })
  .merge(statusTransitionInputSchema);
export type TransitionCustomerStatusInput = z.infer<
  typeof transitionCustomerStatusSchema
>;
