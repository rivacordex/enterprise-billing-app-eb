import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { BillRunList } from "@/components/billing/bill-run-list";
import { PlaceholderBanner } from "@/components/billing/placeholder-banner";
import { isBillrunPlaceholderMode } from "@/lib/config";
import { reportError } from "@/lib/logger";
import { listActiveBillCycles } from "@/services/accounts/bill-cycle";
import { getBusinessToday } from "@/services/billing/business-today";
import { materializeDueRuns } from "@/services/billing/materialize-runs";
import { listRuns } from "@/services/billing/read/list-runs";
import { billRunsListSearchParamsSchema } from "@/validation/billing/bill-runs-list.schema";

// Authenticated, uncached — the guard reads the session and run status/totals
// are read live and never revalidate-cached (code-standards §3.6, Inv. #12).
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Bill Runs" };

interface BillRunsPageProps {
  searchParams: Promise<{
    tab?: string | string[];
    cycle?: string | string[];
    status?: string | string[];
    page?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BillRunsPage({
  searchParams,
}: BillRunsPageProps): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.BILLRUN_VIEW, LEVELS.READ);

  const raw = await searchParams;
  const parsed = billRunsListSearchParamsSchema.parse({
    tab: firstValue(raw.tab),
    cycle: firstValue(raw.cycle) ?? null,
    status: firstValue(raw.status) ?? null,
    page: firstValue(raw.page) ?? 1,
  });

  // One business "today" for the whole render, so the just-materialized run is
  // judged against the same day it was created (no midnight-straddle skew).
  const today = getBusinessToday();

  // Lazy materialization is a write on this server render (architecture Inv.
  // #10) — it must run before the list read so a just-due run appears on the
  // first load. Idempotent + concurrency-safe via the unique constraint. A
  // failed lazy write must not take down the read-only list, so it degrades to
  // a logged error and the page still renders existing runs.
  try {
    await materializeDueRuns(today);
  } catch (error) {
    reportError(error, { at: "bill-runs:materializeDueRuns" });
  }

  // The cycle list and the run list are independent reads — run them together.
  const [cycles, page] = await Promise.all([
    listActiveBillCycles(),
    listRuns(
      {
        tab: parsed.tab,
        cycleId: parsed.cycle,
        status: parsed.status,
        page: parsed.page,
      },
      { today },
    ),
  ]);

  return (
    <main className="space-y-6 p-6">
      <div>
        <h1 className="text-h1 font-semibold text-foreground">Bill Runs</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Materialized monthly runs per active bill cycle — trigger, review, and
          post from here.
        </p>
      </div>

      {isBillrunPlaceholderMode && <PlaceholderBanner />}

      <BillRunList
        page={page}
        cycles={cycles.map((c) => ({ id: c.billCycleId, name: c.name }))}
        hasCycles={cycles.length > 0}
        placeholderMode={isBillrunPlaceholderMode}
        activeCycle={parsed.cycle}
        activeStatus={parsed.status}
      />
    </main>
  );
}
