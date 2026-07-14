import type { Metadata } from "next";
import Link from "next/link";
import { SearchX } from "lucide-react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { OrganizationForm } from "@/components/customers/organization-form";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";
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
  await requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.EDIT);

  const { id } = await params;
  const idResult = partyRoleIdSchema.safeParse(id);
  const detail = idResult.success
    ? await getCustomerDetail(idResult.data)
    : null;

  if (detail === null) {
    return <CustomerNotFound />;
  }

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

      {/* cm10 adds <CustomerRoleForm /> here */}
      {/* cm11 adds <ContactManagerPanel /> here */}
    </main>
  );
}
