// bm03-spec §Design/Implementation §6. Pure, total predicate over calendar
// dates — no DB access. **Strict** partial-period rule (bm03-spec resolved
// decision #4): a start on `period_start` or a cease on `period_end` is
// full-period, not excluded. `YYYY-MM-DD` string comparison is
// lexicographically correct (list-runs.ts precedent) — no `Date` math needed.

export interface PartialPeriodWindow {
  periodStart: string;
  periodEnd: string;
}

export interface SubscriptionWindow {
  startDate: string;
  endDate: string | null;
}

// A transition "to SUSPENDED/RESUMED" (bm03-spec §Design): the suspend event
// itself (`toStatus === "SUSPENDED"`) or the matching resume event
// (`fromStatus === "SUSPENDED"` and `toStatus === "ACTIVE"` — the lifecycle
// service's actual resume write, services/inventory/resume-subscription.ts;
// there is no standalone "RESUMED" member in `ProductStatus`).
export interface StatusTransition {
  fromStatus: string | null;
  toStatus: string;
  effectiveDate: string;
}

export interface PartialPeriodInput extends PartialPeriodWindow {
  subscriptions: SubscriptionWindow[];
  transitions: StatusTransition[];
}

function isSuspendOrResume(t: StatusTransition): boolean {
  return (
    t.toStatus === "SUSPENDED" ||
    (t.fromStatus === "SUSPENDED" && t.toStatus === "ACTIVE")
  );
}

export function isPartialPeriod(input: PartialPeriodInput): boolean {
  const { periodStart, periodEnd, subscriptions, transitions } = input;

  for (const sub of subscriptions) {
    // Started mid-period: strictly after period_start.
    if (sub.startDate > periodStart) return true;
    // Ceased mid-period: strictly before period_end, but not before the
    // window started (a subscription that already ended before this window
    // began never touched it).
    if (
      sub.endDate !== null &&
      sub.endDate < periodEnd &&
      sub.endDate >= periodStart
    ) {
      return true;
    }
  }

  for (const t of transitions) {
    if (
      isSuspendOrResume(t) &&
      t.effectiveDate > periodStart &&
      t.effectiveDate < periodEnd
    ) {
      return true;
    }
  }

  return false;
}
