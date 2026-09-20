import { z } from "zod";

// pm42-spec (code-standards §7.4). The only thing the transition services share
// is the parsing of their optional free-text reason (offering id is a separate
// positional action param, pm22 convention). Captured in the audit payload as
// `transitionReason`, never a column (Inv., architecture §5). Shared by
// submit-for-testing and return-to-draft; activate keeps its own identical
// schema (activate-offering.schema.ts) so its shipped tests are untouched.
export const transitionSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, "Reason must be 500 characters or fewer")
    .optional(),
});

export type TransitionInput = z.infer<typeof transitionSchema>;
