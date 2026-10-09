// bm55-spec §Design D4 (`history` tab), code-standards Part 2 Styling rule 7 —
// `VersionHistoryTable`. A SERVER component reusing the Administration table
// markup (the rate-card version table's primitives — square data grid, sunken
// header, overline labels), never a parallel table. One row per generated
// version, newest first as the caller hands them. "Used by" is the SQL count
// of `customer_bill` rows stamped with the version (tabular-nums). bm56 reuses
// it for company-profile versions.

import Link from "next/link";
import { Download, Eye, History } from "lucide-react";

import { TemplateVersionStatusBadge } from "@/components/billing/invoice-settings/template-version-status-badge";
import { formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { TemplateVersionHistoryRow } from "@/types/billing";

export const INVOICE_TEMPLATE_FILES_BASE =
  "/administration/invoice-settings/invoice-template/versions";

export interface VersionHistoryTableProps {
  rows: TemplateVersionHistoryRow[];
  shownVersionId: string;
  locale: string;
  timezone: string;
}

const HEADERS = [
  "Version",
  "Status",
  "Layout",
  "Created by",
  "Created at",
  "Activated at",
  "Retired at",
  "Change note",
  "Used by",
  "Actions",
] as const;

const MUTED = "text-[color:var(--text-muted)]";
const LINK =
  "inline-flex items-center gap-1 text-body-sm font-medium text-[color:var(--action-primary-bg)] hover:underline focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none";

function usedByLabel(count: number): string {
  return `${count} ${count === 1 ? "invoice" : "invoices"}`;
}

export function VersionHistoryTable({
  rows,
  shownVersionId,
  locale,
  timezone,
}: VersionHistoryTableProps): React.JSX.Element {
  return (
    <div className="rounded-none border border-border bg-card">
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 bg-[color:var(--surface-sunken)] py-16 text-center">
          <History className={cn("size-12", MUTED)} aria-hidden />
          <p className="text-body text-muted-foreground">
            No template versions yet.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
                {HEADERS.map((label) => (
                  <th
                    key={label}
                    scope="col"
                    className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isShown = row.billTemplateVersionId === shownVersionId;
                return (
                  <tr
                    key={row.billTemplateVersionId}
                    className={cn(
                      "border-b border-[color:var(--border-subtle)] last:border-0",
                      isShown && "bg-[color:var(--surface-selected)]",
                      row.status === "RETIRED" && MUTED,
                    )}
                  >
                    <td className="px-4 py-2 font-mono text-mono tabular-nums">
                      v{row.versionNo}
                      <span className={cn("ml-2 text-caption", MUTED)}>
                        {row.billTemplateVersionId}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <TemplateVersionStatusBadge
                        status={row.status}
                        isDefault={row.isDefault}
                      />
                    </td>
                    <td className="px-4 py-2 font-mono text-mono whitespace-nowrap">
                      {row.layoutLabel}
                    </td>
                    <td className="px-4 py-2 font-mono text-mono">
                      {row.createdBy ?? <span className={MUTED}>System</span>}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {formatDatetime(row.createdAt, locale, timezone)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {formatDatetime(row.activatedAt, locale, timezone, "—")}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {formatDatetime(row.retiredAt, locale, timezone, "—")}
                    </td>
                    <td className="max-w-xs px-4 py-2 text-body-sm">
                      {row.changeNote ?? <span className={MUTED}>—</span>}
                    </td>
                    <td
                      className="px-4 py-2 whitespace-nowrap tabular-nums"
                      data-testid="used-by"
                    >
                      {usedByLabel(row.usedByCount)}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-3 whitespace-nowrap">
                        <Link
                          href={`?tab=edit&version=${row.billTemplateVersionId}`}
                          className={LINK}
                        >
                          <Eye size={14} aria-hidden />
                          View
                        </Link>
                        {row.status === "DRAFT" ? null : (
                          <a
                            href={`${INVOICE_TEMPLATE_FILES_BASE}/${row.billTemplateVersionId}/files/invoice.hbs`}
                            download
                            className={LINK}
                          >
                            <Download size={14} aria-hidden />
                            Download .hbs
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
