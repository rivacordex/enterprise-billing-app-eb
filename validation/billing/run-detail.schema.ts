import { z } from "zod";

// bm04-spec §Implementation §9, code-standards §3.3. Lenient tab
// searchParams parsing — an invalid/stale `?tab=` falls back to the
// `workflow` default rather than erroring (bill-runs-list.schema.ts idiom).
// Only `workflow` is populated in bm04; the other four are inert
// placeholders filled by bm05-07.
// bm20-spec §Implementation §6 — the Distribution tab, populated once a run
// reaches `INVOICED` (D-T3's four states: INVOICED-pending / DISTRIBUTING /
// COMPLETED / DISTRIBUTION_FAILED).
export const RUN_DETAIL_TABS = [
  "workflow",
  "customers",
  "uncharged",
  "errors",
  "distribution",
  "audit",
] as const;
export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];

export const runDetailSearchParamsSchema = z.object({
  tab: z.enum(RUN_DETAIL_TABS).catch("workflow"),
});

export type RunDetailSearchParams = z.infer<typeof runDetailSearchParamsSchema>;
