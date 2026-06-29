"use client";

import { ChevronDown, FileSearch } from "lucide-react";
import { useState } from "react";

import { AuditEventCategoryBadge } from "@/components/audit-log/audit-event-category-badge";
import { formatZoneTimestamp } from "@/lib/timezone";
import type { AuditEventCategory, AuditLogRow } from "@/types/audit-log";

interface AuditLogTableProps {
  rows: AuditLogRow[];
  // Resolved server-side from the `APP_TIMEZONE` env var and threaded in as a
  // prop (um29-spec §2.5) — the row timestamp renders in this zone.
  timezone: string;
}

const CATEGORY_BORDER_COLORS: Record<AuditEventCategory, string> = {
  Additive: "var(--color-success-500)",
  Change: "var(--color-info-500)",
  Removal: "var(--color-danger-500)",
  Session: "var(--color-cyan-500)",
  Security: "var(--color-warning-500)",
};

function formatJsonPanel(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return JSON.stringify(value, null, 2);
}

export function AuditLogTable({
  rows,
  timezone,
}: AuditLogTableProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleRow(auditId: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(auditId)) {
        next.delete(auditId);
      } else {
        next.add(auditId);
      }
      return next;
    });
  }

  return (
    <table className="w-full border-collapse text-body">
      <thead>
        <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
          <th className="w-2 p-0" />
          <th className="w-28 px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Category
          </th>
          <th className="w-44 px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Timestamp
          </th>
          <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Event
          </th>
          <th className="w-40 px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Actor
          </th>
          <th className="w-48 px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Target
          </th>
          <th className="w-10 px-4 py-3 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase" />
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={7} className="py-16 text-center">
              <FileSearch className="mx-auto mb-3 size-12 text-[color:var(--text-disabled)]" />
              <p className="text-body text-muted-foreground">
                No audit events found
              </p>
            </td>
          </tr>
        ) : (
          rows.map((row) => {
            const isExpanded = expanded.has(row.auditId);
            return (
              <AuditLogTableRow
                key={row.auditId}
                row={row}
                timezone={timezone}
                isExpanded={isExpanded}
                onToggle={() => toggleRow(row.auditId)}
              />
            );
          })
        )}
      </tbody>
    </table>
  );
}

function AuditLogTableRow({
  row,
  timezone,
  isExpanded,
  onToggle,
}: {
  row: AuditLogRow;
  timezone: string;
  isExpanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <>
      <tr className="border-b border-[color:var(--border-subtle)] hover:bg-[color:var(--color-neutral-50)]">
        <td
          className="w-2 p-0"
          aria-hidden="true"
          style={{ backgroundColor: CATEGORY_BORDER_COLORS[row.category] }}
        />
        <td className="px-4 py-3">
          <AuditEventCategoryBadge category={row.category} />
        </td>
        {/* Cell text renders in the configured zone (local + Intl offset
            suffix, or the literal `… UTC` when the zone is UTC — byte-identical
            to today); the hover `title` keeps the raw UTC ISO instant for
            forensics (um29-spec §2.5). */}
        <td
          className="px-4 py-3 whitespace-nowrap"
          title={row.createdDatetime.toISOString()}
        >
          <span className="font-mono text-mono text-muted-foreground">
            {formatZoneTimestamp(row.createdDatetime, timezone)}
          </span>
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <span className="font-mono text-mono text-foreground">
            {row.eventType}
          </span>
        </td>
        <td className="px-4 py-3">
          <AuditLogActorCell row={row} />
        </td>
        <td className="px-4 py-3">
          <div className="text-body-sm font-medium text-foreground">
            {row.targetEntity ?? "—"}
          </div>
          {row.targetId !== null && (
            <div
              className="max-w-[180px] truncate font-mono text-mono text-muted-foreground"
              title={row.targetId}
            >
              {row.targetId}
            </div>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={onToggle}
            aria-label={isExpanded ? "Hide event detail" : "Show event detail"}
            aria-expanded={isExpanded}
            className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none"
          >
            <ChevronDown
              className={`size-4 transition-transform duration-150 ${isExpanded ? "rotate-180" : ""}`}
            />
          </button>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td
            colSpan={7}
            className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)] px-6 py-4"
          >
            <div className="grid grid-cols-2 gap-4">
              {(["Before", "After"] as const).map((label) => {
                const value =
                  label === "Before" ? row.beforeData : row.afterData;
                return (
                  <div key={label}>
                    <div className="mb-1 text-overline font-semibold tracking-wide text-muted-foreground uppercase">
                      {label}
                    </div>
                    <pre className="max-h-64 overflow-y-auto rounded-sm border border-border bg-card p-3 font-mono text-mono break-all whitespace-pre-wrap text-foreground">
                      {formatJsonPanel(value)}
                    </pre>
                  </div>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AuditLogActorCell({ row }: { row: AuditLogRow }): React.JSX.Element {
  if (row.actorUserId === null) {
    return <span className="text-body-sm text-muted-foreground">—</span>;
  }
  if (row.actorUserName !== null && !row.actorDeleted) {
    return (
      <span className="text-body-sm text-foreground">{row.actorUserName}</span>
    );
  }
  if (row.actorUserName !== null && row.actorDeleted) {
    return (
      <span className="text-body-sm text-muted-foreground">
        {row.actorUserName} <span className="text-overline">(deleted)</span>
      </span>
    );
  }
  return (
    <span
      className="font-mono text-mono text-muted-foreground"
      title={row.actorUserId}
    >
      {row.actorUserId.slice(0, 8)}… (deleted)
    </span>
  );
}
