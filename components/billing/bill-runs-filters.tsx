"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { TERMINAL_RUN_STATUSES } from "@/types/billing";

// bm02-spec §6. Cycle filter (both tabs) + a Historical-only status filter
// (audit-log filter idiom). The status filter is scoped to the Historical
// tab's terminal statuses: offering it on Current would corrupt per-cycle
// operability resolution, and offering non-terminal statuses on Historical
// would be an always-empty dead-end. Applying preserves the active `tab` and
// resets `page` to 1; view state lives in the URL, never a client store
// (code-standards §3.3).

export interface CycleOption {
  id: string;
  name: string;
}

interface BillRunsFiltersProps {
  cycles: CycleOption[];
  tab: "current" | "historical";
}

export function BillRunsFilters({
  cycles,
  tab,
}: BillRunsFiltersProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [cycle, setCycle] = useState(searchParams.get("cycle") ?? "");
  const [status, setStatus] = useState(searchParams.get("status") ?? "");
  const showStatus = tab === "historical";

  const hasActiveFilters =
    Boolean(searchParams.get("cycle")) ||
    (showStatus && Boolean(searchParams.get("status")));

  function handleApply(): void {
    const params = new URLSearchParams();
    params.set("tab", tab);
    if (cycle) params.set("cycle", cycle);
    if (showStatus && status) params.set("status", status);
    params.set("page", "1");
    router.replace(`${pathname}?${params.toString()}`);
  }

  function handleClear(): void {
    setCycle("");
    setStatus("");
    router.replace(`${pathname}?tab=${tab}`);
  }

  return (
    <div className="rounded-md bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="filter-cycle">
            Bill cycle
          </label>
          <select
            id="filter-cycle"
            aria-label="Bill cycle"
            value={cycle}
            onChange={(e) => setCycle(e.target.value)}
            className="h-9 w-52 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          >
            <option value="">All cycles</option>
            {cycles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {showStatus && (
          <div className="flex flex-col gap-1">
            <label className="sr-only" htmlFor="filter-status">
              Status
            </label>
            <select
              id="filter-status"
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-9 w-52 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
            >
              <option value="">All statuses</option>
              {TERMINAL_RUN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}

        <Button onClick={handleApply}>Apply</Button>
        {hasActiveFilters && (
          <Button variant="outline" onClick={handleClear}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
