"use server";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { csvField } from "@/lib/csv";
import { isRedirectError } from "@/lib/errors";
import { listRuns } from "@/services/billing/read/list-runs";
import type { RunListRow } from "@/types/billing";
import { billRunsListSearchParamsSchema } from "@/validation/billing/bill-runs-list.schema";

// bm02-spec §7. CSV export of the currently-filtered run list, as a Server
// Action returning CSV text (NOT a Route Handler — general code-standards §5
// reserves handlers for auth/M2M). Re-checks `billrun_view:READ` (the UI
// disabling is not the gate). A read-only export is NOT audited (§7). The
// client control builds a `Blob` and triggers the download.

export type ExportRunsResult =
  | { ok: true; filename: string; csv: string }
  | { ok: false; code: "FORBIDDEN" };

const CSV_HEADER = [
  "Run ID",
  "Cycle",
  "Period Start",
  "Period End",
  "Scheduled Run Date",
  "Status",
  "Run Type",
] as const;

function buildCsv(rows: RunListRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.billRunId,
        row.cycleName,
        row.periodStart,
        row.periodEnd,
        row.scheduledRunDate,
        row.status,
        row.runType,
      ]
        .map(csvField)
        .join(","),
    );
  }
  // Trailing newline so the file ends cleanly.
  return lines.join("\r\n") + "\r\n";
}

export async function exportRunsAction(input: {
  tab?: string | null;
  cycle?: string | null;
  status?: string | null;
}): Promise<ExportRunsResult> {
  try {
    await requirePermission(PERMISSIONS.BILLRUN_VIEW, LEVELS.READ);
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  // Lenient parse — same defaults as the page (stale/tampered input never
  // throws, it just exports the default view).
  const parsed = billRunsListSearchParamsSchema.parse({
    tab: input.tab ?? undefined,
    cycle: input.cycle ?? null,
    status: input.status ?? null,
    page: 1,
  });

  const { rows } = await listRuns(
    {
      tab: parsed.tab,
      cycleId: parsed.cycle,
      status: parsed.status,
      page: 1,
    },
    { paginate: false },
  );

  return {
    ok: true,
    filename: `bill-runs-${parsed.tab}.csv`,
    csv: buildCsv(rows),
  };
}
