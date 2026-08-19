import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { todayInZone } from "@/lib/timezone";
import { getAppTimezone } from "@/services/system-config/app-config-read.service";
import {
  TERMINAL_RUN_STATUSES,
  type RunListPage,
  type RunListRow,
  type RunStatus,
  type RunType,
} from "@/types/billing";

// bm02-spec §4/§3. The run-list read model. Returns `RunListRow[]` with
// operability + past-due fully derived so the page never re-derives them
// (code-standards §2.7). Two tabs: Current & Upcoming (every non-terminal run,
// grouped by cycle in the component) and Historical (terminal runs, paginated).

const HISTORICAL_PAGE_SIZE = 50;

// A run is a candidate for operation while it is before approval or is a
// rerunnable failure (bm02-spec Design §Operability — `*_FAILED` runs stay
// operable in Current). APPROVED and everything past it are locked; terminal
// runs never reach this read path for the Current tab.
const OPERABLE_CANDIDATE_STATUSES: ReadonlySet<RunStatus> = new Set([
  "SCHEDULED",
  "PROCESSING",
  "PROCESSED",
  "PROCESSING_FAILED",
  "DISTRIBUTION_FAILED",
]);

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

export interface ListRunsParams {
  tab: "current" | "historical";
  cycleId: string | null;
  status: RunStatus | null;
  page: number;
}

interface ListRunsOptions {
  // The CSV export pulls the full filtered set with no pagination (bm02-spec §7).
  paginate?: boolean;
  // The business "today" resolved once by the page and threaded through, so a
  // single render is internally consistent (materialize + list agree on the
  // day). Defaults to a fresh resolution for standalone callers (e.g. export).
  today?: string;
}

// The status filter only makes sense within a tab's own status domain: the
// Current tab shows non-terminal runs (a status filter there would corrupt the
// per-cycle operability resolution, so it is ignored), and the Historical tab
// shows only terminal runs (a non-terminal status is ignored rather than
// producing an always-empty dead-end). Cycle filtering applies to both tabs.
function effectiveStatus(
  tab: "current" | "historical",
  status: RunStatus | null,
): RunStatus | null {
  if (tab !== "historical") return null;
  return status !== null && TERMINAL.has(status) ? status : null;
}

export async function listRuns(
  params: ListRunsParams,
  { paginate = true, today }: ListRunsOptions = {},
): Promise<RunListPage> {
  const businessToday = today ?? todayInZone(new Date(), getAppTimezone());
  const isHistorical = params.tab === "historical";
  const usePaging = isHistorical && paginate;

  const filters = {
    tab: params.tab,
    cycleId: params.cycleId,
    status: effectiveStatus(params.tab, params.status),
  };

  let page = 1;
  let pageSize: number;
  let total: number;
  let rows;

  if (usePaging) {
    // Count first so the requested page can be clamped to the last real page —
    // an out-of-range `?page=` returns the last page, never a false-empty slice.
    total = await billRunRepository.countRuns(db, filters);
    const lastPage = Math.max(1, Math.ceil(total / HISTORICAL_PAGE_SIZE));
    page = Math.min(Math.max(params.page, 1), lastPage);
    pageSize = HISTORICAL_PAGE_SIZE;
    rows = await billRunRepository.listRuns(db, {
      ...filters,
      limit: HISTORICAL_PAGE_SIZE,
      offset: (page - 1) * HISTORICAL_PAGE_SIZE,
    });
  } else {
    // Grouped Current view / CSV export: the full filtered set, no COUNT(*).
    rows = await billRunRepository.listRuns(db, {
      ...filters,
      limit: null,
      offset: 0,
    });
    total = rows.length;
    pageSize = rows.length;
  }

  // Resolve the single operable run per cycle: the oldest operable-candidate
  // whose period has closed (`scheduled_run_date <= today`). Repository rows
  // are ordered (cycleName asc, scheduledRunDate asc), so the first match per
  // cycle is the oldest past-due (Design §Operability). Historical rows are
  // read-only — never operable. Because the status filter is dropped on the
  // Current tab (above), operability is always resolved over the cycle's full
  // non-terminal set, never a filtered subset.
  const operableRunIds = new Set<string>();
  if (!isHistorical) {
    const cyclesResolved = new Set<string>();
    for (const row of rows) {
      if (cyclesResolved.has(row.refBillCycleId)) continue;
      const status = row.status as RunStatus;
      if (
        OPERABLE_CANDIDATE_STATUSES.has(status) &&
        row.scheduledRunDate <= businessToday
      ) {
        operableRunIds.add(row.billRunId);
        cyclesResolved.add(row.refBillCycleId);
      }
    }
  }

  const listRows: RunListRow[] = rows.map((row) => ({
    billRunId: row.billRunId,
    cycleId: row.refBillCycleId,
    cycleName: row.cycleName,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    scheduledRunDate: row.scheduledRunDate,
    status: row.status as RunStatus,
    runType: row.runType as RunType,
    operable: operableRunIds.has(row.billRunId),
    // Lexicographic compare is correct for zero-padded `YYYY-MM-DD`.
    pastDue: row.scheduledRunDate <= businessToday,
  }));

  return { tab: params.tab, rows: listRows, total, page, pageSize };
}
