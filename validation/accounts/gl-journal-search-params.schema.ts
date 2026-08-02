// ac13-spec §2.1 / §2.4 — URL param validation for /accounts/gl-journal.
// All params have safe .catch() fallbacks so a bad URL never throws; the page
// always renders with the default selection. sort is a URL param so a future
// export (ac14) matches on-screen order (code-standards §4.3).

import { z } from "zod";

// Mirrors GL_JOURNAL_SORT_VALUES in the repository. Defined here independently
// because the validation layer may not import from db/ (boundaries rule).
const SORT_VALUES = [
  "gl_code",
  "-gl_code",
  "debit",
  "-debit",
  "credit",
  "-credit",
] as const;

// Default period: current calendar month in YYYY-MM.
function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export const glJournalSearchParamsSchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .catch(currentPeriod()),
  currency: z.string().length(3).catch("MYR"),
  view: z.enum(["movement", "trial"]).catch("movement"),
  sort: z.enum(SORT_VALUES).catch("gl_code"),
  expand: z.string().optional().catch(undefined),
});

export type GlJournalSearchParams = z.infer<typeof glJournalSearchParamsSchema>;
