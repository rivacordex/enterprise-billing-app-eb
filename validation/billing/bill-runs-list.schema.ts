import { z } from "zod";

import { RUN_STATUSES, type RunStatus } from "@/types/billing";

// bm02-spec §5. Lenient list view-state parsing (code-standards §3.3): every
// field falls back to its default on a parse failure rather than throwing, so
// a tampered or stale URL never 500s the page — it just loads the default
// tab/filters. Mirrors the audit-log searchParams idiom.
const statusSchema = z
  .string()
  .refine((v): v is RunStatus =>
    (RUN_STATUSES as readonly string[]).includes(v),
  )
  .nullable()
  .catch(null);

export const billRunsListSearchParamsSchema = z.object({
  tab: z.enum(["current", "historical"]).catch("current"),
  cycle: z.string().min(1).nullable().catch(null),
  status: statusSchema,
  page: z.coerce.number().int().min(1).catch(1),
});

export type BillRunsListSearchParams = z.infer<
  typeof billRunsListSearchParamsSchema
>;
