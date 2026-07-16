import { z } from "zod";

export const customerSearchParamsSchema = z.object({
  q: z.string().trim().max(200).catch(""),
});
export type CustomerSearchParams = z.infer<typeof customerSearchParamsSchema>;
