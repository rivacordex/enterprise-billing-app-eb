import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { SearchX } from "lucide-react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { AccountsLockedCard } from "@/components/customers/accounts-locked-card";
import { AccountsTabSkeleton } from "@/components/customers/accounts-tab-skeleton";
import { CustomerAccountsTab } from "@/components/customers/customer-accounts-tab";
import { OrganizationSection } from "@/components/customers/organization-section";
import { CustomerRoleSection } from "@/components/customers/customer-role-section";
import { ContactDetailsSection } from "@/components/customers/contact-details-section";
import { CustomerDetailTabs } from "@/components/customers/customer-detail-tabs";
import {
  InconsistencyBanner,
  isStatusInconsistent,
} from "@/components/customers/inconsistency-banner";
import { firstValue } from "@/lib/search-params";
import { getCustomerAccountsSummary } from "@/services/accounts/get-customer-accounts-summary";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { partyRoleIdSchema } from "@/validation/customer/party-role.schema";
import { meetsLevel } from "@/types/permissions";
import { customerDetailSearchParamsSchema } from "@/validation/customer/search-params.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "View Customer" };

function CustomerNotFound(): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-[color:var(--surface-sunken)] p-12 text-center">
      <SearchX className="mx-auto mb-3 size-12 text-[color:var(--text-muted)]" />
      <p className="text-body font-medium text-foreground">
        Customer not found
      </p>
      <Link
        href="/customers/view"
        className="mt-1 inline-block text-body-sm text-primary underline"
      >
        Back to Customer search
      </Link>
    </div>
  );
}

// cm20 (custmgmt Inv. #15, D16) — streams the Accounts tab under Suspense.
// Rendered only for ?tab=accounts and only when the viewer holds
// accounts_view : READ, so Profile/Contacts and locked viewers run no account
// query. Lives here, not in components/**, because components may not import
// services/** (boundaries rule); CustomerAccountsTab stays presentational.
async function CustomerAccountsTabLoader({
  partyRoleId,
  page,
  locale,
  timezone,
}: {
  partyRoleId: string;
  page: number;
  locale: string;
  timezone: string;
}): Promise<React.JSX.Element> {
  const summary = await getCustomerAccountsSummary(partyRoleId, page);
  return (
    <CustomerAccountsTab
      partyRoleId={partyRoleId}
      summary={summary}
      locale={locale}
      timezone={timezone}
    />
  );
}

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    tab?: string | string[];
    page?: string | string[];
  }>;
}): Promise<React.JSX.Element> {
  const { permissionMap } = await requirePermission(
    PERMISSIONS.CUSTOMERS,
    LEVELS.READ,
  );

  const { id } = await params;
  const idResult = partyRoleIdSchema.safeParse(id);

  const detail = idResult.success
    ? await getCustomerDetail(idResult.data)
    : null;

  if (detail === null) {
    return <CustomerNotFound />;
  }

  // cm19 (custmgmt Inv. #14) — the active tab lives in the URL; cm20 adds
  // the Accounts tab document page.
  const rawSearchParams = await searchParams;
  const { tab, page } = customerDetailSearchParamsSchema.parse({
    tab: firstValue(rawSearchParams.tab),
    page: firstValue(rawSearchParams.page),
  });
  // cm20 (custmgmt Inv. #12) — the Accounts tab sub-gate, checked once here.
  const canViewAccounts = meetsLevel(
    permissionMap[PERMISSIONS.ACCOUNTS_VIEW],
    LEVELS.READ,
  );

  const [locale, timezone] = await Promise.all([
    getAppLocale(),
    getAppTimezone(),
  ]);
  const inconsistent = isStatusInconsistent(
    detail.organization.status,
    detail.customerRole.status,
  );

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">
          {detail.organization.name}
        </h1>
        <p className="mt-1 text-body text-muted-foreground">
          Customer {detail.customerRole.partyRoleId}
        </p>
      </header>

      {inconsistent && (
        <InconsistencyBanner
          organizationStatus={detail.organization.status}
          customerStatus={detail.customerRole.status}
        />
      )}

      <CustomerDetailTabs activeTab={tab} />

      {tab === "profile" && (
        <div className="space-y-6">
          <OrganizationSection
            organization={detail.organization}
            locale={locale}
            timezone={timezone}
          />
          <CustomerRoleSection
            customerRole={detail.customerRole}
            locale={locale}
            timezone={timezone}
          />
        </div>
      )}
      {tab === "contacts" && (
        <ContactDetailsSection contacts={detail.contacts} />
      )}
      {tab === "accounts" && (
        <div aria-label="Accounts">
          {canViewAccounts ? (
            <Suspense fallback={<AccountsTabSkeleton />}>
              <CustomerAccountsTabLoader
                partyRoleId={detail.customerRole.partyRoleId}
                page={page}
                locale={locale}
                timezone={timezone}
              />
            </Suspense>
          ) : (
            <AccountsLockedCard />
          )}
        </div>
      )}
    </main>
  );
}
