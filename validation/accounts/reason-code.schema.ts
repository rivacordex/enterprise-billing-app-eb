import { z } from "zod";

import { DOC_TYPES, POSTING_NATURES } from "@/types/accounts";

export const upsertReasonCodeSchema = z.object({
  reasonCode: z
    .string()
    .min(1)
    .max(50)
    .regex(
      /^[A-Z0-9_]+$/,
      "Code must be uppercase letters, digits, and underscores only",
    ),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  docType: z.enum(DOC_TYPES),
  postingNature: z.enum(POSTING_NATURES),
  autoPostLimit: z
    .string()
    .regex(
      /^\d{1,16}(\.\d{1,2})?$/,
      "Must be a non-negative decimal with at most 16 integer digits (e.g. 1000.00)",
    ),
  // ISO string — present when editing an existing code (CAS lock); absent
  // for new codes. z.coerce.date() converts back in the service layer.
  lastModified: z.iso.datetime().optional(),
});

export type UpsertReasonCodeInput = z.infer<typeof upsertReasonCodeSchema>;

export const retireReasonCodeSchema = z.object({
  reasonCode: z.string().min(1),
  lastModified: z.iso.datetime(),
});

export type RetireReasonCodeInput = z.infer<typeof retireReasonCodeSchema>;
