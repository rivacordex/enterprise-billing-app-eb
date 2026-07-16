import { z } from "zod";

import { ORGANIZATION_TYPES } from "@/types/customer";

export const organizationIdSchema = z.string().regex(/^ORG\d{7}$/);

// Reused verbatim by both create-customer (cm07) and update-organization
// (cm08) — one shape, not two hand-kept copies (cm02-spec §2.2.2).
export const organizationFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  tradingName: z.string().trim().min(1).max(200).nullable().default(null),
  organizationType: z.enum(ORGANIZATION_TYPES),
  registrationNumber: z.string().trim().min(1).max(50).nullable().default(null),
  taxId: z.string().trim().min(1).max(50).nullable().default(null),
  industry: z.string().trim().min(1).max(100).nullable().default(null),
});
export type OrganizationFields = z.infer<typeof organizationFieldsSchema>;
