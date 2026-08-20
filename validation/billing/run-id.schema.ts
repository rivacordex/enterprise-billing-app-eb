import { z } from "zod";

// bm04-spec §Implementation §6/§9, code-standards §2.6. The `BRN`+8-digit
// format check, shared by the run-detail page and the M2M `[runId]` route
// param parsers — one regex, never re-declared.
export const billRunIdSchema = z
  .string()
  .regex(/^BRN\d{8}$/, "Invalid bill run id.");
