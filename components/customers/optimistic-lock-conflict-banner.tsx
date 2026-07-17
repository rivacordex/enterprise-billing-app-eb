import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface OptimisticLockConflictBannerProps {
  onReload: () => void;
  // Defaults to "customer", matching every pre-existing call site (cm08-spec
  // §3.7). Only StatusTransitionControl overrides it, since it's the one
  // caller that mutates either a customer or an organization.
  entityLabel?: string;
}

// Shared across every mutation unit from this one through cm15 (cm08-spec
// §3.7) — the same `CONFLICT` outcome always renders the same reload
// prompt. Reuses `InconsistencyBanner`'s (cm05) warning tokens verbatim,
// just a different message and an action button.
export function OptimisticLockConflictBanner({
  onReload,
  entityLabel = "customer",
}: OptimisticLockConflictBannerProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border-l-4 border-[color:var(--banner-warning-border)] bg-[color:var(--banner-warning-bg)] p-3 text-body-sm text-[color:var(--banner-warning-fg)]"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div>
        <p>
          This {entityLabel} was changed by someone else. Reload to see the
          latest version.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onReload}
          className="mt-2"
        >
          Reload
        </Button>
      </div>
    </div>
  );
}
