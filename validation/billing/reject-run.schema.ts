import { z } from "zod";

import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm17-spec §Implementation §2. The reject action payload. `scope` mirrors
// the RerunDialog convention rather than a separate radio control: `"all"`
// (whole run — every postable account) or `"selected"` (the explicit
// `banIds`). `reason` is MANDATORY — a trimmed, non-empty string (empty ⇒
// VALIDATION failure, matching the rerun convention, bm08).
export const REJECT_SCOPES = ["all", "selected"] as const;
export type RejectScope = (typeof REJECT_SCOPES)[number];

export const rejectRunSchema = z.object({
  billRunId: billRunIdSchema,
  scope: z.enum(REJECT_SCOPES),
  // BAN-format ids; MAY be empty when scope is "all". Capped so a crafted call
  // cannot build an unbounded `IN (…)` from caller input.
  banIds: z
    .array(z.string().regex(/^BAN\d{8}$/, "Invalid billing account id."))
    .max(5000, "Too many accounts selected.")
    .default([]),
  reason: z.string().trim().min(1, "A reason is required.").max(2000),
});

export type RejectRunInput = z.infer<typeof rejectRunSchema>;
