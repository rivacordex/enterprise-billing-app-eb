import { z } from "zod";

// Q29 — every document requires these three fields: `eventAt` (entry date,
// drives period validation + GL journal), `referenceDate`, `referenceInfo`.
// All three are `timestamptz` in the DB but captured date-only in the UI
// (default today); `z.coerce.date()` accepts either a `Date` or a
// date-only/ISO string from a native `<input type="date">`.
export const documentBaseSchema = z.object({
  eventAt: z.coerce.date(),
  referenceDate: z.coerce.date(),
  referenceInfo: z.string().trim().min(1).max(200),
});
export type DocumentBaseInput = z.infer<typeof documentBaseSchema>;

// Decimal-string amount, reused by every money-input field in this module
// (mirrors `creditLimitSchema`'s pattern, ac04-spec §3.2) — arithmetic
// itself only ever happens in `money.ts`.
export const amountSchema = z
  .string()
  .regex(
    /^\d+(\.\d{1,2})?$/,
    "Must be a non-negative decimal with at most 2 decimal places",
  )
  .max(15, "Must be at most 15 characters");

export const documentIdSchema = z
  .string()
  .regex(/^(PAY|DEP|CRN|DBN|ADJ)\d{8}$/, "Invalid document ID");

// Every state-transition action carries the document's optimistic lock
// (code-standards §2.5) — same shape/convention as
// `customer/party-role.schema.ts`'s `optimisticLockSchema`.
export const documentLockSchema = z.object({
  lastModified: z.coerce.date(),
});
