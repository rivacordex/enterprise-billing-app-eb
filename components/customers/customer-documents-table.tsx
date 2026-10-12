// cm20 (binding plan D6, custmgmt Inv. #11) — read-only document list for the
// View Customer Accounts tab. Server component; deliberately NOT the Accounts
// module's documents-table.tsx (a client component that imports the reversal
// mutation path). Each row deep-links into Accounts → Transactions, whose
// detail drawer opens from `?doc` when `?fa` is set. No action buttons.

import Link from "next/link";

import { AmountCell } from "@/components/accounts/amount-cell";
import { DocStateBadge } from "@/components/accounts/doc-state-badge";
import { formatDatetime } from "@/lib/formatters";
import type { TransactionDocumentRow } from "@/types/accounts";

export interface CustomerDocumentsTableProps {
  partyRoleId: string;
  financialAccountId: string;
  rows: TransactionDocumentRow[];
  total: number;
  page: number;
  pageSize: number;
  locale: string;
  timezone: string;
}

function documentHref(
  partyRoleId: string,
  financialAccountId: string,
  documentId: string,
): string {
  const params = new URLSearchParams({
    party: partyRoleId,
    fa: financialAccountId,
    doc: documentId,
  });
  return `/accounts/transactions?${params.toString()}`;
}

const PAGE_LINK =
  "rounded-sm border border-border px-3 py-1 text-body-sm text-[color:var(--text-link)] hover:text-[color:var(--text-link-hover)]";

export function CustomerDocumentsTable({
  partyRoleId,
  financialAccountId,
  rows,
  total,
  page,
  pageSize,
  locale,
  timezone,
}: CustomerDocumentsTableProps): React.JSX.Element {
  if (total === 0) {
    return (
      <p className="text-body-sm text-[color:var(--text-muted)]">
        No transactions yet.
      </p>
    );
  }

  const hasPrevious = page > 1;
  const hasNext = page * pageSize < total;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border border-border bg-[color:var(--surface-card)]">
        <table className="w-full text-body-sm">
          <thead>
            <tr className="border-b border-border text-left text-overline tracking-wider text-muted-foreground uppercase">
              <th className="px-3 py-2 font-semibold">Document</th>
              <th className="px-3 py-2 font-semibold">Action</th>
              <th className="px-3 py-2 font-semibold">State</th>
              <th className="px-3 py-2 text-right font-semibold">Amount</th>
              <th className="px-3 py-2 font-semibold">Event at</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.documentId}
                className="border-b border-border last:border-b-0"
              >
                <td className="px-3 py-2">
                  <Link
                    href={documentHref(
                      partyRoleId,
                      financialAccountId,
                      row.documentId,
                    )}
                    className="font-mono text-mono text-[color:var(--text-link)] hover:text-[color:var(--text-link-hover)] hover:underline"
                  >
                    {row.documentId}
                  </Link>
                </td>
                <td className="px-3 py-2 text-foreground">{row.actionLabel}</td>
                <td className="px-3 py-2">
                  <DocStateBadge
                    state={row.state}
                    partiallyReversed={row.partiallyReversed}
                  />
                </td>
                <td className="px-3 py-2">
                  <AmountCell
                    amount={row.totalAmount}
                    currency={row.currency}
                  />
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {formatDatetime(row.eventAt, locale, timezone)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(hasPrevious || hasNext) && (
        <nav
          aria-label="Documents pagination"
          className="flex items-center justify-end gap-2"
        >
          {hasPrevious && (
            <Link href={`?tab=accounts&page=${page - 1}`} className={PAGE_LINK}>
              Previous
            </Link>
          )}
          {hasNext && (
            <Link href={`?tab=accounts&page=${page + 1}`} className={PAGE_LINK}>
              Next
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
