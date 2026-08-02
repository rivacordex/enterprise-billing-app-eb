// ac14-spec §3.4 — validation schema for the close-period action.

import { z } from "zod";

import { currencyCodeSchema } from "@/validation/accounts/currency-code.schema";

export const closePeriodSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: "Period must be in YYYY-MM format",
  }),
  currency: currencyCodeSchema,
});

export type ClosePeriodInput = z.infer<typeof closePeriodSchema>;
