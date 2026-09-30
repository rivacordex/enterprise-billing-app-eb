import Link from "next/link";
import { Lock, TableProperties } from "lucide-react";

import { RateCardStatusBadge } from "@/components/products/rate-card/rate-card-status-badge";
import { RATE_CARD_STATUS_BADGE_VARIANTS } from "@/components/products/rate-card/rate-card-status-badge";
import { buildRateCardHref } from "@/components/products/rate-card/rate-card-href";
import { formatCalendarDate, formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { RatecardVersion } from "@/types/product";

// pm65-spec D9 / I2 / ui-context §10.5 — the version list. SERVER component
// (§3.6): rows are `<Link>`s that rewrite `?version=` (§3.4 — no client
// selection state), so the whole table renders on the server, reusing the
// Administration table primitives (the same table markup the families table
// uses, §4.3) rather than a parallel implementation. One row per version,
// newest first (the caller hands them in `uploaded_at DESC`), with mono ids and
// `tabular-nums` counts (§4.29). A SUPERSEDED row renders muted (§1's
// convention for superseded things). `row_count` is the version list's ONLY
// count — a version's rows are exactly its uploaded file (D-A7), so there is no
// second (carried) count and no `retired_at` column (D9).
//
// Uploader/activator render the stored appuser ids in mono (or `—` when null) —
// see the tracker's pm65 note on why names are not resolved here (repository
// boundary + query budget).

export interface RateCardVersionTableProps {
  versions: RatecardVersion[];
  selectedVersionId: string | null;
  locale: string;
  timezone: string;
}

const HEADERS = [
  "ID",
  "Card",
  "Version",
  "Status",
  "Snapshot date",
  "Rows",
  "Uploaded by",
  "Uploaded at",
  "Activated by",
  "Activated at",
] as const;

export function RateCardVersionTable({
  versions,
  selectedVersionId,
  locale,
  timezone,
}: RateCardVersionTableProps): React.JSX.Element {
  return (
    <div className="rounded-md bg-card shadow-sm">
      {/* Card header carries the DB-guarantee note. It states a fact the
          database enforces (the partial unique index, RV1), so it is
          informational — muted with a `lock` glyph — never a warning
          (ui-context §10.5). */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-body font-semibold text-foreground">Versions</h2>
        <p className="inline-flex items-center gap-1.5 text-caption text-[color:var(--text-muted)]">
          <Lock size={12} aria-hidden />
          One Active version per card
        </p>
      </div>

      {versions.length === 0 ? (
        // D10, empty state #1 — "no versions yet for this card". It points at
        // the header upload button WITHOUT repeating it; that button is pm66's,
        // so the copy names it as specified and pm66 supplies the control (D10).
        // This reads differently from the row preview's "no rows match filter"
        // state (the two must never be one blank grid, §6/§10.7).
        <div className="flex flex-col items-center gap-2 bg-[color:var(--surface-sunken)] py-16 text-center">
          <TableProperties className="size-12 text-[color:var(--text-muted)]" />
          <p className="text-body text-muted-foreground">
            No versions yet. Upload a CSV to create the first one.
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
                    className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => {
                const isSelected =
                  version.ratecardVersionId === selectedVersionId;
                const isMuted =
                  RATE_CARD_STATUS_BADGE_VARIANTS[version.status].muted;
                return (
                  <tr
                    key={version.ratecardVersionId}
                    className={cn(
                      "border-b border-[color:var(--border-subtle)] last:border-0 hover:bg-[color:var(--action-ghost-hover)]",
                      isSelected &&
                        "bg-[color:var(--surface-selected)] hover:bg-[color:var(--surface-selected)]",
                      isMuted && "text-[color:var(--text-muted)]",
                    )}
                  >
                    <td className="px-4 py-2">
                      <Link
                        href={buildRateCardHref({
                          version: version.ratecardVersionId,
                        })}
                        aria-current={isSelected ? "page" : undefined}
                        className="font-mono text-mono tabular-nums hover:underline focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none"
                      >
                        {version.ratecardVersionId}
                      </Link>
                    </td>
                    <td className="px-4 py-2 font-mono text-mono">
                      {version.cardName}
                    </td>
                    <td className="px-4 py-2 font-mono text-mono tabular-nums">
                      v{version.versionNum}
                    </td>
                    <td className="px-4 py-2">
                      <RateCardStatusBadge status={version.status} />
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                      {formatCalendarDate(version.snapshotDate, "iso")}
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {version.rowCount}
                    </td>
                    <td className="px-4 py-2 font-mono text-mono">
                      {version.uploadedBy ?? (
                        <span className="text-[color:var(--text-muted)]">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {formatDatetime(version.uploadedAt, locale, timezone)}
                    </td>
                    <td className="px-4 py-2 font-mono text-mono">
                      {version.activatedBy ?? (
                        <span className="text-[color:var(--text-muted)]">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {formatDatetime(
                        version.activatedAt,
                        locale,
                        timezone,
                        "—",
                      )}
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
