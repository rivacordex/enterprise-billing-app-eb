import { z } from "zod";

import { templateFamilyIdSchema } from "@/validation/billing/template-family-id.schema";

// cm21-spec §3.3 / cm23 — bind a BAN to an invoice template type from its own
// customer's Manage page. `partyRoleId` scopes the BAN to that customer;
// `lastModified` is the BAN's own CAS token (Inv. #17). `typeId: null` is
// Standard (Inv. #19). Any well-formed type id parses here; whether it is
// bindable (usable, not Standard's id) is `assertBindableTemplate`'s call.
export const setBillingAccountTemplateSchema = z.object({
  partyRoleId: z.string().regex(/^PTRL\d{8}$/),
  billingAccountId: z.string().regex(/^BAN\d+$/),
  typeId: templateFamilyIdSchema.nullable(),
  lastModified: z.coerce.date(),
});
export type SetBillingAccountTemplateInput = z.infer<
  typeof setBillingAccountTemplateSchema
>;
