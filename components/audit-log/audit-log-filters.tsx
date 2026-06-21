"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { AUDIT_EVENT_TYPES } from "@/types/audit";
import {
  AUDIT_EVENT_CATEGORY_MAP,
  type AuditEventCategory,
  type AuditLogActorOption,
} from "@/types/audit-log";

interface AuditLogFiltersProps {
  actors: AuditLogActorOption[];
}

const CATEGORY_ORDER: AuditEventCategory[] = [
  "Additive",
  "Change",
  "Removal",
  "Session",
  "Security",
];

// Grouped for the `<optgroup>` list (um24-spec §"Filter bar design") —
// derived from the shared category map rather than re-listing all 20 event
// types by hand, so the two stay in sync automatically.
const EVENT_TYPE_OPTIONS = CATEGORY_ORDER.map((category) => ({
  category,
  events: AUDIT_EVENT_TYPES.filter(
    (eventType) => AUDIT_EVENT_CATEGORY_MAP[eventType] === category,
  ),
}));

const FILTER_PARAM_KEYS = [
  "eventType",
  "actorUserId",
  "dateFrom",
  "dateTo",
] as const;

export function AuditLogFilters({
  actors,
}: AuditLogFiltersProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [eventType, setEventType] = useState(
    searchParams.get("eventType") ?? "",
  );
  const [actorUserId, setActorUserId] = useState(
    searchParams.get("actorUserId") ?? "",
  );
  const [dateFrom, setDateFrom] = useState(searchParams.get("dateFrom") ?? "");
  const [dateTo, setDateTo] = useState(searchParams.get("dateTo") ?? "");

  const hasActiveFilters = FILTER_PARAM_KEYS.some((key) =>
    Boolean(searchParams.get(key)),
  );

  function handleApply(): void {
    const params = new URLSearchParams();
    if (eventType) params.set("eventType", eventType);
    if (actorUserId) params.set("actorUserId", actorUserId);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    params.set("page", "1");
    router.replace(`${pathname}?${params.toString()}`);
  }

  function handleClear(): void {
    setEventType("");
    setActorUserId("");
    setDateFrom("");
    setDateTo("");
    router.replace(pathname);
  }

  return (
    <div className="rounded-md bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="filter-event-type">
            Event type
          </label>
          <select
            id="filter-event-type"
            aria-label="Event type"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            className="h-9 w-48 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          >
            <option value="">All events</option>
            {EVENT_TYPE_OPTIONS.map((group) => (
              <optgroup key={group.category} label={group.category}>
                {group.events.map((et) => (
                  <option key={et} value={et}>
                    {et}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="filter-actor">
            Actor
          </label>
          <select
            id="filter-actor"
            aria-label="Actor"
            value={actorUserId}
            onChange={(e) => setActorUserId(e.target.value)}
            className="h-9 w-44 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          >
            <option value="">All actors</option>
            {actors.map((actor) => (
              <option key={actor.userId} value={actor.userId}>
                {actor.userName ?? actor.userId}
                {actor.isDeleted ? " (deleted)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="filter-date-from">
            From date
          </label>
          <input
            id="filter-date-from"
            type="date"
            aria-label="From date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-9 w-36 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="filter-date-to">
            To date
          </label>
          <input
            id="filter-date-to"
            type="date"
            aria-label="To date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-9 w-36 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          />
        </div>

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
