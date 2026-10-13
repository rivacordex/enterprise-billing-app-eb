import { z } from "zod";

// cm21-spec §3.3 (binding plan D15) — reset a BAN's invoice template
// reference from its own customer's Manage page. `partyRoleId` scopes the BAN
// to that customer; `lastModified` is the BAN's own CAS token (Inv. #17).
// v1 sends `billTemplateVersionId: null` only; a non-null id still parses here
// and is refused by `assertBindableTemplate` (TEMPLATE_NOT_BINDABLE).
export const setBillingAccountTemplateSchema = z.object({
  partyRoleId: z.string().regex(/^PTRL\d{8}$/),
  billingAccountId: z.string().regex(/^BAN\d+$/),
  billTemplateVersionId: z
    .string()
    .regex(/^BTV\d{8}$/)
    .nullable(),
  lastModified: z.coerce.date(),
});
export type SetBillingAccountTemplateInput = z.infer<
  typeof setBillingAccountTemplateSchema
>;
