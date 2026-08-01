import { z } from "zod";

// Shape guard for `financial_account.contact` / `billing_account.contact`
// (ac02-spec §2.5). `refContactMedium` points at a `customer.contact_medium`
// row (`CTMD…`) — no FK here since the column is jsonb, cross-schema
// referential integrity for this pointer is a service-layer concern, not a
// DB constraint (module boundary: `billing` never gets a hard FK into
// `customer` beyond `ref_party_role_id`).
export const accountContactSchema = z.strictObject({
  refContactMedium: z.string().regex(/^CTMD\d{8}$/),
  contactType: z.enum(["billing", "finance"]),
  name: z.string().trim().min(1).max(200),
});
export type AccountContact = z.infer<typeof accountContactSchema>;

export const accountContactListSchema = z.array(accountContactSchema);
export type AccountContactList = z.infer<typeof accountContactListSchema>;
