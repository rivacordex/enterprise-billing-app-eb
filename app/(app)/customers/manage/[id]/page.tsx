import type { Metadata } from "next";
import Link from "next/link";
import { SearchX } from "lucide-react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { BillingAccountPanel } from "@/components/customers/billing-account-panel";
import { ContactManagerPanel } from "@/components/customers/contact-manager-panel";
import { CustomerRoleForm } from "@/components/customers/customer-role-form";
import { OrganizationForm } from "@/components/customers/organization-form";
import { listCustomerBillingAccounts } from "@/services/accounts/list-customer-billing-accounts";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { meetsLevel } from "@/types/permissions";
import { partyRoleIdSchema } from "@/validation/customer/party-role.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Manage Customer" };

// Same "Customer not found" shape as cm05's view/[id] page (cm08-spec
// §2.3.3) — two call sites isn't yet worth extracting into a shared
// component.
function CustomerNotFound(): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-[color:var(--surface-sunken)] p-12 text-center">
      <SearchX className="mx-auto mb-3 size-12 text-[color:var(--text-muted)]" />
      <p className="text-body font-medium text-foreground">
        Customer not found
      </p>
      <Link
        href="/customers/manage"
        className="mt-1 inline-block text-body-sm text-primary underline"
      >
        Back to Customer search
      </Link>
    </div>
  );
}

export default async function CustomerEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { permissionMap } = await requirePermission(
    PERMISSIONS.CUSTOMERS,
    LEVELS.EDIT,
  );

  const { id } = await params;
  const idResult = partyRoleIdSchema.safeParse(id);
  const detail = idResult.success
    ? await getCustomerDetail(idResult.data)
    : null;

  if (detail === null) {
    return <CustomerNotFound />;
  }

  // cm21 (Inv. #16) — UX-only gate for the reset control; the action
  // re-checks both permissions.
  const canEditAccounts = meetsLevel(
    permissionMap[PERMISSIONS.ACCOUNTS_TRANSACTIONS],
    LEVELS.EDIT,
  );

  const [locale, timezone, billingAccounts] = await Promise.all([
    getAppLocale(),
    getAppTimezone(),
    listCustomerBillingAccounts(detail.customerRole.partyRoleId),
  ]);

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">
          Edit {detail.organization.name}
        </h1>
        <p className="mt-1 text-body text-muted-foreground">
          Customer {detail.customerRole.partyRoleId}
        </p>
      </header>

      <OrganizationForm
        organization={detail.organization}
        partyRoleId={detail.customerRole.partyRoleId}
        lastModifiedDatetime={detail.customerRole.lastModifiedDatetime}
      />

      <CustomerRoleForm
        customerRole={detail.customerRole}
        locale={locale}
        timezone={timezone}
      />

      <ContactManagerPanel
        partyRoleId={detail.customerRole.partyRoleId}
        contacts={detail.contacts}
        lastModifiedDatetime={detail.customerRole.lastModifiedDatetime}
      />

      <BillingAccountPanel
        partyRoleId={detail.customerRole.partyRoleId}
        accounts={billingAccounts}
        canEditAccounts={canEditAccounts}
      />
    </main>
  );
}
