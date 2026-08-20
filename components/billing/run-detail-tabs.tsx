// bm04-spec §Implementation §9, code-standards §3.3/§3.7. The run-detail
// tab switcher — a plain `<Link ?tab=>` (view state in the URL), server
// component (no interaction beyond navigation, so no 'use client' leaf is
// needed here — mirrors `components/billing/bill-run-list.tsx`'s tab nav).
// Workflow (bm04) and Customers & Bills (bm05) are populated; the rest stay
// inert placeholders filled by bm06-07.

import Link from "next/link";

import { CustomerBillTable } from "@/components/billing/customer-bill-table";
import { StageTimeline } from "@/components/billing/stage-timeline";
import type { RunDetailTab } from "@/validation/billing/run-detail.schema";
import { RUN_DETAIL_TABS } from "@/validation/billing/run-detail.schema";
import type {
  CustomerBillRow,
  StageTimelineRow,
  StageTimelineSummary,
} from "@/types/billing";

const TAB_LABELS: Record<RunDetailTab, string> = {
  workflow: "Workflow",
  customers: "Customers & Bills",
  uncharged: "Uncharged",
  errors: "Errors",
  audit: "Audit",
};

export interface RunDetailTabsProps {
  activeTab: RunDetailTab;
  timeline: {
    rows: StageTimelineRow[];
    summary: StageTimelineSummary;
  };
  customerBills: CustomerBillRow[];
  locale: string;
}

export function RunDetailTabs({
  activeTab,
  timeline,
  customerBills,
  locale,
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
      ) : (
        <PlaceholderPanel label={TAB_LABELS[activeTab]} />
      )}
    </div>
  );
}

function PlaceholderPanel({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-border bg-[color:var(--surface-sunken)] p-10 text-center">
      <p className="text-body font-medium text-foreground">{label}</p>
      <p className="mt-1 text-body-sm text-muted-foreground">
        This tab is not built yet — it ships in a later unit.
      </p>
    </div>
  );
}
