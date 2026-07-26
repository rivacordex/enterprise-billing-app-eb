import { z } from "zod";

// FA/BAN `contact` jsonb shape guard (ac02-spec §2.5, code-standards §6.5).
// `refContactMedium` is a `CTMD…` id (customer module) — not FK-enforced from
// this jsonb array, so shape only.
export const CONTACT_TYPES = ["billing", "finance"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const contactEntrySchema = z.strictObject({
  refContactMedium: z.string(),
  contactType: z.enum(CONTACT_TYPES),
  name: z.string(),
});
export type ContactEntry = z.infer<typeof contactEntrySchema>;

export const contactSchema = z.array(contactEntrySchema);
export type Contact = z.infer<typeof contactSchema>;
