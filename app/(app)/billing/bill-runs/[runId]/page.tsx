import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { RunDetailTabs } from "@/components/billing/run-detail-tabs";
import { RunStatusBadge } from "@/components/billing/run-status-badge";
import { StubDataBanner } from "@/components/billing/stub-data-banner";
import { stubDataMode } from "@/lib/config";
import { formatCalendarDate } from "@/lib/formatters";
import { getRunDetail } from "@/services/billing/read/get-run-detail";
import { getStageTimeline } from "@/services/billing/read/get-stage-timeline";
import { listAccountBills } from "@/services/billing/read/list-account-bills";
import { getAppLocale } from "@/services/system-config/app-config-read.service";
import { billRunIdSchema } from "@/validation/billing/run-id.schema";
import { runDetailSearchParamsSchema } from "@/validation/billing/run-detail.schema";

// bm04-spec §Implementation §9, code-standards §3.1/§3.6. Guard → parse
// params → read → compose tabs. Live status, uncached (Inv. #12). bm05 adds
// the Customers & Bills read (§Implementation §5), fetched only for its own
// tab, same idiom as the Workflow timeline below.
export const dynamic = "force-dynamic";

interface BillRunDetailPageProps {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({
  params,
}: BillRunDetailPageProps): Promise<Metadata> {
  const { runId } = await params;
  return { title: `Bill Run — ${runId}` };
}

export default async function BillRunDetailPage({
  params,
  searchParams,
}: BillRunDetailPageProps): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.BILLRUN_VIEW, LEVELS.READ);

  const { runId: rawRunId } = await params;
  const idResult = billRunIdSchema.safeParse(rawRunId);
  if (!idResult.success) {
    notFound();
  }

  const detail = await getRunDetail(idResult.data);
  if (!detail) {
    notFound();
  }

  const rawSearch = await searchParams;
  const parsedSearch = runDetailSearchParamsSchema.parse({
    tab: firstValue(rawSearch.tab),
  });

  const timeline =
    parsedSearch.tab === "workflow"
      ? await getStageTimeline(detail.billRunId)
      : {
          rows: [],
          summary: { total: 0, processed: 0, processingFailed: 0, excluded: 0 },
        };

  const customerBills =
    parsedSearch.tab === "customers"
      ? await listAccountBills(detail.billRunId)
      : [];

  const locale = await getAppLocale();

  return (
    <main className="space-y-6 p-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-h1 font-semibold text-foreground">
            {detail.billRunId}
          </h1>
          <RunStatusBadge status={detail.status} />
        </div>
        <p className="text-body text-muted-foreground">
          {detail.cycleName} · Period {formatCalendarDate(detail.periodStart)} –{" "}
          {formatCalendarDate(detail.periodEnd)}
        </p>
      </header>

      {stubDataMode && <StubDataBanner />}

      <RunDetailTabs
        activeTab={parsedSearch.tab}
        timeline={timeline}
        customerBills={customerBills}
        locale={locale}
      />
    </main>
  );
}
