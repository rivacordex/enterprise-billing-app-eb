import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { CustomerResultsTable } from "@/components/customers/customer-results-table";
import { CustomerSearchPanel } from "@/components/customers/customer-search-panel";
import { searchCustomers } from "@/services/customer/search-customers";
import { customerSearchParamsSchema } from "@/validation/customer/search-params.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Manage Customer" };

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ManageCustomerSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.EDIT);

  const raw = await searchParams;
  const parsed = customerSearchParamsSchema.parse({ q: firstValue(raw.q) });

  // `searchCustomers` (cm02) only ever runs for a non-empty query — an empty
  // query never touches services/db at all, matching the empty-start state.
  const results = parsed.q ? await searchCustomers(parsed.q) : null;

  return (
    <main className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-h1 font-semibold text-foreground">
            Manage Customer
          </h1>
          <p className="mt-1 text-body text-muted-foreground">
            Search for an existing customer, or add a new one.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Link
            href="/customers/manage/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--action-cta-bg)] px-3 py-2 text-body-sm font-semibold text-white"
          >
            <Plus size={16} aria-hidden />
            Add new customer
          </Link>
          <span className="text-caption text-muted-foreground">
            Search first to confirm this customer doesn&apos;t already exist.
          </span>
        </div>
      </header>

      <CustomerSearchPanel query={parsed.q} baseHref="/customers/manage" />

      {results !== null && (
        <CustomerResultsTable results={results} basePath="/customers/manage" />
      )}
    </main>
  );
}
