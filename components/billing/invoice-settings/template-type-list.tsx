// bm77-spec §8 (ui-context §10a/§10e) — `TemplateTypeList`, the invoice
// template type list. A SERVER component with the Administration table chrome
// of `VersionHistoryTable` (square corners, sunken header). Name links to the
// type's detail page; Status is the one `TemplateVersionStatusBadge` with the
// derived type state, plus the Default chip on Standard. Retired rows are
// hidden unless `showRetired`. No empty state: Standard always exists. The
// "Bound BANs" column arrives with bm82 (cm23 adds the column it reads).

import Link from "next/link";

import { TemplateVersionStatusBadge } from "@/components/billing/invoice-settings/template-version-status-badge";
import { TEMPLATE_TYPE_MESSAGES } from "@/components/billing/invoice-settings/template-type-messages";
import { formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { TemplateTypeListRow } from "@/types/billing";

const HEADERS = ["Name", "Status", "Active version", "Active since"] as const;
const MUTED = "text-[color:var(--text-muted)]";
const DETAIL_BASE = "/administration/invoice-settings/invoice-template";

export interface TemplateTypeListProps {
  rows: readonly TemplateTypeListRow[];
  showRetired: boolean;
  locale: string;
  timezone: string;
}

export function TemplateTypeList({
  rows,
  showRetired,
  locale,
  timezone,
}: TemplateTypeListProps): React.JSX.Element {
  const visible = showRetired
    ? rows
    : rows.filter((r) => r.status !== "RETIRED");
  const hasRetired = rows.some((r) => r.status === "RETIRED");

  return (
    <div className="space-y-2">
      <div className="rounded-none border border-border bg-card">
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
              {visible.map((row) => (
                <tr
                  key={row.billTemplateFamilyId}
                  className={cn(
                    "border-b border-[color:var(--border-subtle)] last:border-0",
                    row.status === "RETIRED" && MUTED,
                  )}
                >
                  <td className="px-4 py-2">
                    <Link
                      href={`${DETAIL_BASE}/${row.billTemplateFamilyId}`}
                      className="font-medium text-[color:var(--action-primary-bg)] hover:underline"
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <TemplateVersionStatusBadge
                      status={row.status}
                      isDefault={row.isDefault}
                    />
                  </td>
                  <td className="px-4 py-2 font-mono text-mono tabular-nums">
                    {row.activeVersionNo === null ? (
                      <span className={MUTED}>—</span>
                    ) : (
                      `v${row.activeVersionNo}`
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {formatDatetime(row.activeSince, locale, timezone, "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {hasRetired || showRetired ? (
        <Link
          href={showRetired ? "?" : "?retired=1"}
          className="text-body-sm font-medium text-[color:var(--action-primary-bg)] hover:underline"
        >
          {showRetired
            ? TEMPLATE_TYPE_MESSAGES.hideRetired
            : TEMPLATE_TYPE_MESSAGES.showRetired}
        </Link>
      ) : null}
    </div>
  );
}
