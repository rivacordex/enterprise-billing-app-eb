import Link from "next/link";

import { CustomerStatusBadge } from "@/components/customers/customer-status-badge";
import { OrganizationStatusBadge } from "@/components/customers/organization-status-badge";
import { cn } from "@/lib/utils";
import type { CustomerSearchResults } from "@/types/customer";

export interface CustomerResultsTableProps {
  results: CustomerSearchResults;
  basePath: string;
}

export function CustomerResultsTable({
  results,
  basePath,
}: CustomerResultsTableProps): React.JSX.Element {
  if (results.results.length === 0) {
    return (
      <div className="rounded-md border border-border bg-[color:var(--surface-sunken)] p-8 text-center text-muted-foreground">
        No customers match your search.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <table className="w-full border-collapse text-body-sm">
        <thead className="bg-[color:var(--surface-sunken)] text-overline text-muted-foreground uppercase">
          <tr>
            <th className="px-3 py-2 text-left">Organization</th>
            <th className="px-3 py-2 text-left">Trading Name</th>
            <th className="px-3 py-2 text-left">Organization Status</th>
            <th className="px-3 py-2 text-left">Customer Status</th>
            <th className="px-3 py-2 text-left">Customer ID</th>
          </tr>
        </thead>
        <tbody>
          {results.results.map((row) => {
            const muted =
              row.customerStatus === "CLOSED" ||
              row.organizationStatus === "DISSOLVED" ||
              row.organizationStatus === "MERGED";
            return (
              <tr
                key={row.partyRoleId}
                className={cn(
                  "border-b border-border",
                  muted && "text-muted-foreground",
                )}
              >
                <td className="px-3 py-2">
                  <Link
                    href={`${basePath}/${row.partyRoleId}`}
                    className="hover:underline"
                  >
                    {row.organizationName}
                  </Link>
                </td>
                <td className="px-3 py-2">{row.tradingName ?? "—"}</td>
                <td className="px-3 py-2">
                  <OrganizationStatusBadge status={row.organizationStatus} />
                </td>
                <td className="px-3 py-2">
                  <CustomerStatusBadge status={row.customerStatus} />
                </td>
                <td className="px-3 py-2 font-mono text-muted-foreground tabular-nums">
                  {row.partyRoleId}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {results.hasMore && (
        <p className="text-body-sm text-muted-foreground">
          Showing the first {results.limit} matches — refine your search for
          more precise results.
        </p>
      )}
    </div>
  );
}
