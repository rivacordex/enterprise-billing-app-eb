import type { Metadata } from "next";
import Link from "next/link";
import { SearchX } from "lucide-react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { OrganizationSection } from "@/components/customers/organization-section";
import { CustomerRoleSection } from "@/components/customers/customer-role-section";
import { ContactDetailsSection } from "@/components/customers/contact-details-section";
import {
  InconsistencyBanner,
  isStatusInconsistent,
} from "@/components/customers/inconsistency-banner";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { partyRoleIdSchema } from "@/validation/customer/party-role.schema";

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

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.READ);

  const { id } = await params;
  const idResult = partyRoleIdSchema.safeParse(id);

  const detail = idResult.success
    ? await getCustomerDetail(idResult.data)
    : null;

  if (detail === null) {
    return <CustomerNotFound />;
  }

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
        <ContactDetailsSection contacts={detail.contacts} />
      </div>
    </main>
  );
}
