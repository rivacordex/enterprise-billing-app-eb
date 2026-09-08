import { z } from "zod";

// bm18-spec §Implementation §3, code-standards §2.6 — the `BAN`+8-digit
// format check for the draft-invoice route's `[banId]` param, mirroring
// `run-id.schema.ts`'s `billRunIdSchema` shape (the same regex already
// inlined at each existing call site: reject/rerun schemas, the stage-signal
// schema).
export const billingAccountIdSchema = z
  .string()
  .regex(/^BAN\d{8}$/, "Invalid billing account id.");
