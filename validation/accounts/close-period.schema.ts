// ac14-spec §3.4 — validation schema for the close-period action.

import { z } from "zod";

export const closePeriodSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: "Period must be in YYYY-MM format",
  }),
  currency: z
    .string()
    .length(3, { message: "Currency must be a 3-character code" }),
});

export type ClosePeriodInput = z.infer<typeof closePeriodSchema>;
