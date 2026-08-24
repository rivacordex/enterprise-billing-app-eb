"use client";

// bm12-spec §Visual/§Implementation §5. `StallBanner` — a derived-state
// Warning-family banner (ui-context §1/§7), shown on the run detail ONLY
// when `isStalled` computes true (services/billing/stall.ts) — never a
// stored `STALLED` pill (architecture Inv. #10). Offers "Check status"
// (primary) and, via `CancelRunDialog`, "Cancel run" (secondary, danger,
// inside a spelled-out confirm dialog).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { checkStatusAction } from "@/actions/billing/check-status.action";
import { CancelRunDialog } from "@/components/billing/cancel-run-dialog";
import { Button } from "@/components/ui/button";
import { formatDatetime } from "@/lib/formatters";

export interface StallBannerProps {
  billRunId: string;
  lastProgressAt: Date | null;
  locale: string;
  timezone: string;
}

export function StallBanner({
  billRunId,
  lastProgressAt,
  locale,
  timezone,
}: StallBannerProps): React.JSX.Element {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCheckStatus(): Promise<void> {
    setChecking(true);
    setError(null);
    setMessage(null);
    try {
      const result = await checkStatusAction({ billRunId });
      if (!result.ok) {
        setError(describeError(result.code));
        return;
      }
      setMessage(
        result.value.mismatch
          ? "The engine reports the execution finished, but not every account has reached a terminal state — investigate before relying on this run."
          : `Engine reports ${result.value.engineState.toLowerCase()}. Run status: ${result.value.runStatus}.`,
      );
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div
      role="status"
      className="space-y-2 rounded-sm border border-[color:var(--color-warning-500)] bg-[color:var(--color-warning-50)] px-4 py-3 text-body-sm text-[color:var(--color-warning-700)]"
    >
      <div className="flex flex-wrap items-center gap-2 font-medium">
        <AlertTriangle size={16} aria-hidden="true" />
        <span>
          No heartbeat since {formatDatetime(lastProgressAt, locale, timezone)}{" "}
          — this run may be stalled.
        </span>
      </div>

      {message && (
        <p
          role="status"
          aria-live="polite"
          className="text-body-sm font-medium text-[color:var(--color-warning-700)]"
        >
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={checking}
          onClick={() => void handleCheckStatus()}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {checking ? "Checking…" : "Check status"}
        </Button>
        <CancelRunDialog billRunId={billRunId} />
      </div>
    </div>
  );
}

function describeError(code: string): string {
  switch (code) {
    case "NOT_FOUND":
      return "This run could not be found.";
    case "NO_EXECUTION":
      return "This run has no recorded execution to check.";
    case "ENGINE_UNREACHABLE":
      return "The processing engine could not be reached. Try again shortly.";
    case "FORBIDDEN":
      return "You do not have permission to check bill run status.";
    default:
      return "Something went wrong. Please try again.";
  }
}
