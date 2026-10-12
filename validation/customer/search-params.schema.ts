import { z } from "zod";

export const customerSearchParamsSchema = z.object({
  q: z.string().trim().max(200).catch(""),
});
export type CustomerSearchParams = z.infer<typeof customerSearchParamsSchema>;

// cm19 (custmgmt Inv. #14) — View Customer detail tabs. Lenient: an unknown or
// stale ?tab= falls back to "profile" (run-detail.schema.ts idiom).
export const CUSTOMER_DETAIL_TABS = [
  "profile",
  "contacts",
  "accounts",
] as const;
export type CustomerDetailTab = (typeof CUSTOMER_DETAIL_TABS)[number];

export const customerDetailSearchParamsSchema = z.object({
  tab: z.enum(CUSTOMER_DETAIL_TABS).catch("profile"),
  // cm20 — Accounts tab document page; lenient like `tab`.
  page: z.coerce.number().int().min(1).max(9999).catch(1),
});
