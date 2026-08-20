import { z } from "zod";

// bm03-spec §Implementation §7. `BRN`+8 digits (code-standards §2.6).
export const triggerRunSchema = z.object({
  billRunId: z.string().regex(/^BRN\d{8}$/, "Invalid bill run id."),
});

export type TriggerRunInput = z.infer<typeof triggerRunSchema>;
