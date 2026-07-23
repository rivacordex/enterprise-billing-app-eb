"use client";

import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  PackageSearch,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { LifecycleBadge } from "@/components/products/lifecycle-badge";
import { CreateOfferingDialog } from "@/components/products/manage/create-offering-dialog";
import { cn } from "@/lib/utils";
import type { OfferingFamilyRow, OfferingListRow } from "@/types/product";

interface ManageOfferingTableProps {
  families: OfferingFamilyRow[];
  locale: string;
  timezone: string;
}

const ACTION_BUTTON_CLASS =
  "inline-flex size-7 items-center justify-center rounded-sm border-[0.5px] border-[color:var(--border)] outline-none focus-visible:[box-shadow:var(--focus-ring)]";

// Every button in this matrix renders now, real icon + real aria-label, and
// does nothing when clicked — the seam pm19–pm23 fill in one at a time
// (pm18-spec §2.6). None are `disabled`.
function RowActions({ row }: { row: OfferingListRow }): React.JSX.Element {
  if (row.lifecycleStatus === "RETIRED") {
    return (
      <span className="text-caption text-[color:var(--text-muted)]">
        No actions — retired
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label={`Edit ${row.name}`}
        className={cn(ACTION_BUTTON_CLASS, "text-muted-foreground")}
        // pm20 seam: onClick opens OfferingForm in edit mode
      >
        <Pencil size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={`Add price to ${row.name}`}
        className={cn(ACTION_BUTTON_CLASS, "text-muted-foreground")}
        // pm22 seam: onClick opens the add-price dialog
      >
        <CircleDollarSign size={14} aria-hidden />
      </button>
      {row.lifecycleStatus === "DRAFT" ? (
        <>
          <button
            type="button"
            aria-label={`Activate ${row.name}`}
            className={cn(ACTION_BUTTON_CLASS, "text-muted-foreground")}
            // pm23 seam: onClick activates the offering
          >
            <Check size={14} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`Discard ${row.name}`}
            className={cn(ACTION_BUTTON_CLASS, "text-destructive")}
            // pm23 seam: onClick discards the draft
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </>
      ) : (
        <button
          type="button"
          aria-label={`Retire ${row.name}`}
          className={cn(ACTION_BUTTON_CLASS, "text-destructive")}
          // pm23 seam: onClick retires the offering
        >
          <Archive size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

function FamilyRows({
  family,
  expanded,
  onToggle,
}: {
  family: OfferingFamilyRow;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { primary } = family;
  const hasVersions = family.versions.length > 1;
  const isRetired = primary.lifecycleStatus === "RETIRED";

  return (
    <>
      <tr
        className={cn(
          "border-b border-[color:var(--border-subtle)] last:border-0",
          isRetired && "text-[color:var(--text-muted)]",
        )}
      >
        <td className="w-10 px-2 py-2">
          {hasVersions && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? `Hide other versions of ${primary.name}`
                  : `Show other versions of ${primary.name}`
              }
              className="flex size-6 items-center justify-center text-[color:var(--text-muted)]"
            >
              {expanded ? (
                <ChevronDown size={16} aria-hidden />
              ) : (
                <ChevronRight size={16} aria-hidden />
              )}
            </button>
          )}
        </td>
        <td className="px-4 py-2 font-mono text-mono tabular-nums">
          {primary.productOfferingId}
        </td>
        <td className="px-4 py-2 text-foreground">{primary.name}</td>
        <td className="px-4 py-2">
          <LifecycleBadge status={primary.lifecycleStatus} />
        </td>
        <td className="px-4 py-2 font-mono text-mono tabular-nums">
          {primary.version}
        </td>
        <td className="px-4 py-2">
          <RowActions row={primary} />
        </td>
      </tr>
      {expanded &&
        family.versions.map((version) => {
          const versionRetired = version.lifecycleStatus === "RETIRED";
          return (
            <tr
              key={version.productOfferingId}
              className={cn(
                "border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)] last:border-0",
                versionRetired && "text-[color:var(--text-muted)]",
              )}
            >
              <td className="w-10 px-2 py-2" />
              <td className="px-4 py-2 pl-8 font-mono text-mono tabular-nums">
                {version.productOfferingId}
              </td>
              <td className="px-4 py-2 text-foreground">{version.name}</td>
              <td className="px-4 py-2">
                <LifecycleBadge status={version.lifecycleStatus} />
              </td>
              <td className="px-4 py-2 font-mono text-mono tabular-nums">
                {version.version}
              </td>
              <td className="px-4 py-2">
                <RowActions row={version} />
              </td>
            </tr>
          );
        })}
    </>
  );
}

// `locale`/`timezone` are accepted for forward-compat with a future
// "last modified" column (pm18-spec §3.7 note 6) — this unit's column set
// doesn't render one yet, so they're threaded through the prop signature
// but not consumed by this component's markup.
export function ManageOfferingTable({
  families,
}: ManageOfferingTableProps): React.JSX.Element {
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(
    new Set(),
  );

  function toggleFamily(familyId: string): void {
    setExpandedFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(familyId)) {
        next.delete(familyId);
      } else {
        next.add(familyId);
      }
      return next;
    });
  }

  return (
    <div className="rounded-md bg-card shadow-sm">
      <div className="flex items-center justify-end border-b border-border p-4">
        <CreateOfferingDialog
          trigger={
            <button
              type="button"
              aria-label="New offering"
              className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--action-cta-bg)] px-3 py-2 text-body-sm font-semibold text-white"
            >
              <Plus size={16} aria-hidden />
              New offering
            </button>
          }
        />
      </div>

      {families.length === 0 ? (
        <div className="flex flex-col items-center gap-3 bg-[color:var(--surface-sunken)] py-16 text-center">
          <PackageSearch className="size-12 text-[color:var(--text-muted)]" />
          <p className="text-body text-muted-foreground">
            No offerings yet — create one to get started
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
                <th className="w-10 px-2 py-3" aria-hidden />
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  ID
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Version
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {families.map((family) => (
                <FamilyRows
                  key={family.familyId}
                  family={family}
                  expanded={expandedFamilies.has(family.familyId)}
                  onToggle={() => toggleFamily(family.familyId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
