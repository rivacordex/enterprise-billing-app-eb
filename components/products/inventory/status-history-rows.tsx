import { SubscriptionStatusBadge } from "@/components/products/inventory/subscription-status-badge";
import type { StatusHistoryEntry, SuspensionWindow } from "@/types/inventory";

export interface StatusHistoryRowsProps {
  history: StatusHistoryEntry[];
  suspensionWindows: SuspensionWindow[];
  colSpan: number;
}

// pm33-spec §Design — expandable indented sub-rows (--surface-sunken, the
// Manage Products family-expand affordance, ui-context §9) rendering the
// append-only transition log (architecture Inv. #18) plus the derived
// suspension window(s) summarized beneath. `StatusHistoryEntry` (pm32) carries
// no database id, so each transition's own from/to/effective-date is its
// identity — no separate "event id" column is fabricated here.
export function StatusHistoryRows({
  history,
  suspensionWindows,
  colSpan,
}: StatusHistoryRowsProps): React.JSX.Element {
  return (
    <tr className="bg-[color:var(--surface-sunken)]">
      <td colSpan={colSpan} className="px-4 py-3">
        <div className="flex flex-col gap-3 pl-8">
          <div className="overflow-x-auto rounded-md border border-[color:var(--border-subtle)]">
            <table className="w-full max-w-2xl border-collapse text-body-sm">
              <thead>
                <tr className="border-b border-[color:var(--border-subtle)] text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  <th className="px-3 py-1.5 text-left">From</th>
                  <th className="px-3 py-1.5 text-left">To</th>
                  <th className="px-3 py-1.5 text-left">Effective</th>
                  <th className="px-3 py-1.5 text-left">Reason</th>
                  <th className="px-3 py-1.5 text-left">Actor</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry, index) => (
                  <tr
                    key={`${entry.to}-${entry.effectiveDate}-${index}`}
                    className="border-b border-[color:var(--border-subtle)] last:border-0"
                  >
                    <td className="px-3 py-1.5">
                      {entry.from ? (
                        <SubscriptionStatusBadge status={entry.from} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <SubscriptionStatusBadge status={entry.to} />
                    </td>
                    <td className="px-3 py-1.5 tabular-nums">
                      {entry.effectiveDate}
                    </td>
                    <td className="px-3 py-1.5 text-foreground">
                      {entry.reason ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-foreground">
                      {entry.changedByName}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {suspensionWindows.length > 0 && (
            <div className="flex flex-col gap-1">
              {suspensionWindows.map((window, index) => (
                <p
                  key={`${window.from}-${index}`}
                  className="text-caption text-muted-foreground"
                >
                  Suspended {window.from} → {window.to ?? "ongoing"} — excluded
                  from rating
                </p>
              ))}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}
