// bm04-spec §Implementation §9, code-standards §3.3/§3.7. The run-detail
// tab switcher — a plain `<Link ?tab=>` (view state in the URL), server
// component (no interaction beyond navigation, so no 'use client' leaf is
// needed here — mirrors `components/billing/bill-run-list.tsx`'s tab nav).
// Workflow (bm04), Customers & Bills (bm05), and Uncharged/Errors/Audit
// (bm07) are all populated.

import Link from "next/link";

import { AuditTable } from "@/components/billing/audit-table";
import { CustomerBillTable } from "@/components/billing/customer-bill-table";
import { ErrorsTable } from "@/components/billing/errors-table";
import { StageTimeline } from "@/components/billing/stage-timeline";
import { UnchargedTable } from "@/components/billing/uncharged-table";
import type { AuditLogRow } from "@/types/audit-log";
import type { RunDetailTab } from "@/validation/billing/run-detail.schema";
import { RUN_DETAIL_TABS } from "@/validation/billing/run-detail.schema";
import type {
  CustomerBillRow,
  ErrorRow,
  StageTimelineRow,
  StageTimelineSummary,
  UnchargedRow,
} from "@/types/billing";

const TAB_LABELS: Record<RunDetailTab, string> = {
  workflow: "Workflow",
  customers: "Customers & Bills",
  uncharged: "Uncharged",
  errors: "Errors",
  audit: "Audit",
};

export interface RunDetailTabsProps {
  runId: string;
  activeTab: RunDetailTab;
  timeline: {
    rows: StageTimelineRow[];
    summary: StageTimelineSummary;
  };
  customerBills: CustomerBillRow[];
  uncharged: UnchargedRow[];
  errors: ErrorRow[];
  audit: AuditLogRow[];
  canRecover: boolean;
  canOperate: boolean;
  locale: string;
  timezone: string;
}

export function RunDetailTabs({
  runId,
  activeTab,
  timeline,
  customerBills,
  uncharged,
  errors,
  audit,
  canRecover,
  canOperate,
  locale,
  timezone,
}: RunDetailTabsProps): React.JSX.Element {
  return (
    <div className="space-y-4">
      <nav
        aria-label="Bill run detail tabs"
        className="flex gap-1 border-b border-border"
      >
        {RUN_DETAIL_TABS.map((tab) => {
          const active = activeTab === tab;
          return (
            <Link
              key={tab}
              href={`?tab=${tab}`}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "border-b-2 border-[color:var(--color-primary-500)] px-4 py-2 text-body-sm font-semibold text-foreground"
                  : "border-b-2 border-transparent px-4 py-2 text-body-sm font-medium text-muted-foreground hover:text-foreground"
              }
            >
              {TAB_LABELS[tab]}
            </Link>
          );
        })}
      </nav>

      {activeTab === "workflow" ? (
        <StageTimeline rows={timeline.rows} summary={timeline.summary} />
      ) : activeTab === "customers" ? (
        <CustomerBillTable rows={customerBills} locale={locale} />
      ) : activeTab === "uncharged" ? (
        <UnchargedTable
          runId={runId}
          rows={uncharged}
          canRecover={canRecover}
        />
      ) : activeTab === "errors" ? (
        <ErrorsTable runId={runId} rows={errors} canOperate={canOperate} />
      ) : (
        <AuditTable rows={audit} timezone={timezone} />
      )}
    </div>
  );
}
