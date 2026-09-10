import { z } from "zod";

import {
  DISTRIBUTION_ARTIFACT_TYPES,
  DISTRIBUTION_OUTCOMES,
} from "@/types/billing";
import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm20-spec §Implementation §4. The third M2M handler's body — one
// per-artifact-per-target outcome. `strictObject` (matching
// `stageSignalBodySchema`'s convention) rejects any undeclared key with a
// 422. `attempt` is a resolved addition beyond the spec's literal body shape
// (`{target, artifact_ref, artifact_type, is_mandatory, outcome}`) — T1's
// stale-round guard needs the flow to echo back which `distribution_attempt`
// it is reporting for, the same way `stageSignalBodySchema.attempt` lets
// `handle-stage-signal.ts` reject a superseded execution's signal.
export const runIdParamSchema = billRunIdSchema;

export const distributionOutcomeBodySchema = z.strictObject({
  target: z.string().min(1).max(100),
  artifact_ref: z.string().min(1).max(200),
  artifact_type: z.enum(DISTRIBUTION_ARTIFACT_TYPES),
  is_mandatory: z.boolean(),
  outcome: z.enum(DISTRIBUTION_OUTCOMES),
  attempt: z.number().int().min(1),
});

export type DistributionOutcomeBody = z.infer<
  typeof distributionOutcomeBodySchema
>;
