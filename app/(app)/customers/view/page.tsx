import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { CustomerResultsTable } from "@/components/customers/customer-results-table";
import { CustomerSearchPanel } from "@/components/customers/customer-search-panel";
import { searchCustomers } from "@/services/customer/search-customers";
import { customerSearchParamsSchema } from "@/validation/customer/search-params.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "View Customer" };

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ViewCustomerSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.READ);

  const raw = await searchParams;
  const parsed = customerSearchParamsSchema.parse({ q: firstValue(raw.q) });

  // `searchCustomers` (cm02) only ever runs for a non-empty query — an empty
  // query never touches services/db at all, matching the empty-start state.
  const results = parsed.q ? await searchCustomers(parsed.q) : null;

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">View Customer</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Search for an enterprise customer by organization or trading name.
        </p>
      </header>

      <CustomerSearchPanel query={parsed.q} baseHref="/customers/view" />

      {results !== null && (
        <CustomerResultsTable results={results} basePath="/customers/view" />
      )}
    </main>
  );
}
