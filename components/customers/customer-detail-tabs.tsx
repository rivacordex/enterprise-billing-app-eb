// cm19-spec §3.2, custmgmt Inv. #14, custmgmt-ui-context §9.1. The View
// Customer tab strip — plain `<Link ?tab=>` (view state in the URL), server
// component, no data access. Classes copied from
// `components/billing/run-detail-tabs.tsx`, plus the §9.1 keyboard focus ring
// (`--focus-ring`, the platform's focus-visible idiom) that precedent lacks.

import Link from "next/link";

import type { CustomerDetailTab } from "@/validation/customer/search-params.schema";
import { CUSTOMER_DETAIL_TABS } from "@/validation/customer/search-params.schema";

const TAB_LABELS: Record<CustomerDetailTab, string> = {
  profile: "Profile",
  contacts: "Contacts",
  accounts: "Accounts",
};

export interface CustomerDetailTabsProps {
  activeTab: CustomerDetailTab;
}

export function CustomerDetailTabs({
  activeTab,
}: CustomerDetailTabsProps): React.JSX.Element {
  return (
    <nav
      aria-label="Customer detail tabs"
      className="flex gap-1 border-b border-border"
    >
      {CUSTOMER_DETAIL_TABS.map((tab) => {
        const active = activeTab === tab;
        return (
          <Link
            key={tab}
            href={`?tab=${tab}`}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "border-b-2 border-[color:var(--color-primary-500)] px-4 py-2 text-body-sm font-semibold text-foreground focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none"
                : "border-b-2 border-transparent px-4 py-2 text-body-sm font-medium text-muted-foreground hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none"
            }
          >
            {TAB_LABELS[tab]}
          </Link>
        );
      })}
    </nav>
  );
}
