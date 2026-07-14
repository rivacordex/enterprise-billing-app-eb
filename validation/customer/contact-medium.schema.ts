import { z } from "zod";

export const contactMediumIdSchema = z.string().regex(/^CTMD\d{8}$/);

// No cross-field refinement here (e.g. "at least one method populated") —
// that invariant is service-layer (cm11), not a shape check.
export const contactFieldsSchema = z.object({
  contactName: z.string().trim().min(1).max(200),
  contactRole: z.string().trim().min(1).max(100).nullable().default(null),
  phoneNumber: z.string().trim().min(3).max(30).nullable().default(null),
  emailAddress: z.string().trim().email().nullable().default(null),
  addressLine1: z.string().trim().min(1).max(200).nullable().default(null),
  addressLine2: z.string().trim().min(1).max(200).nullable().default(null),
  city: z.string().trim().min(1).max(100).nullable().default(null),
  stateProvince: z.string().trim().min(1).max(100).nullable().default(null),
  postalCode: z.string().trim().min(1).max(20).nullable().default(null),
  country: z.string().trim().min(1).max(100).nullable().default(null),
});
export type ContactFields = z.infer<typeof contactFieldsSchema>;
