import { z } from "zod";

import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm08-spec §Implementation §2. The rerun action payload. `fromStage` is
// restricted to the re-derivable stages Validation → Verification (the stage
// selector's options, §Design/Visual) — `scoping` ran at trigger and
// posting/rendering/distribution are post-approval, so none is a rerun origin.
// `accountIds` is BAN-format and MAY be empty: an empty set means "all eligible
// accounts in the run" (the run-level Rerun control), a non-empty set is the
// explicit selection (the Errors tab's "Rerun these accounts"). `reason` is
// MANDATORY — a trimmed, non-empty string (empty ⇒ VALIDATION failure, §5).
export const RERUN_STAGES = [
  "validation",
  "collection",
  "aggregation",
  "taxation",
  "verification",
] as const;
export type RerunStage = (typeof RERUN_STAGES)[number];

export const rerunRunSchema = z.object({
  billRunId: billRunIdSchema,
  // BAN-format ids; MAY be empty (⇒ all eligible). Capped so a crafted call
  // cannot build an unbounded `IN (…)` from caller input (duplicates collapse
  // harmlessly in the service's Set-based filter, so a cap suffices).
  accountIds: z
    .array(z.string().regex(/^BAN\d{8}$/, "Invalid billing account id."))
    .max(5000, "Too many accounts selected.")
    .default([]),
  fromStage: z.enum(RERUN_STAGES),
  reason: z.string().trim().min(1, "A reason is required.").max(2000),
});

export type RerunRunInput = z.infer<typeof rerunRunSchema>;
