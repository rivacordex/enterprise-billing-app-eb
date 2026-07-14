import { AlertTriangle } from "lucide-react";

import type { CustomerStatus, OrganizationStatus } from "@/types/customer";

// The InconsistencyBanner rule, authored here per cm05-spec §2.2 (deferred
// by cm02 §2.2.10, "warn only, no cascade" per architecture). Widening this
// rule is a design-doc change (cm05-spec §2.2, architecture §6 territory),
// not a silent edit to this function.
export function isStatusInconsistent(
  organizationStatus: OrganizationStatus,
  customerStatus: CustomerStatus,
): boolean {
  // Rule 1 — the overview's literal example, generalized: a billable
  // customer sitting on an organization that isn't in good trading standing.
  if (customerStatus === "ACTIVE" && organizationStatus !== "ACTIVE") {
    return true;
  }

  // Rule 2 — a terminated organization (DISSOLVED/MERGED) with an
  // engagement that hasn't been wound down (anything other than CLOSED).
  if (
    (organizationStatus === "DISSOLVED" || organizationStatus === "MERGED") &&
    customerStatus !== "CLOSED"
  ) {
    return true;
  }

  return false;
}

export interface InconsistencyBannerProps {
  organizationStatus: OrganizationStatus;
  customerStatus: CustomerStatus;
}

export function InconsistencyBanner({
  organizationStatus,
  customerStatus,
}: InconsistencyBannerProps): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border-l-4 border-[color:var(--banner-warning-border)] bg-[color:var(--banner-warning-bg)] p-3 text-body-sm text-[color:var(--banner-warning-fg)]"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        This customer&apos;s status (<strong>{customerStatus}</strong>) and its
        organization&apos;s status (<strong>{organizationStatus}</strong>)
        don&apos;t line up — this is a warning only; nothing was changed
        automatically.
      </span>
    </div>
  );
}
