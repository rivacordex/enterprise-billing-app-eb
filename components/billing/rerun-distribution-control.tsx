"use client";

// bm20-spec §Implementation §3, §Phase-2 review fold D-T1 — the
// DISTRIBUTION_FAILED state's primary/emphasized control (the happy path):
// redeliver exactly the failed artifacts. Plain explicit-click, no confirm
// modal — mirrors `StartDistributionControl`; the "posted INVs untouched"
// framing (spec §Visual) is stated in copy, not gated behind a dialog, since
// this action never touches money.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

import { rerunDistributionAction } from "@/actions/billing/rerun-distribution.action";
import { Button } from "@/components/ui/button";

export interface RerunDistributionControlProps {
  billRunId: string;
}

export function RerunDistributionControl({
  billRunId,
}: RerunDistributionControlProps): React.JSX.Element {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRerun(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await rerunDistributionAction({ billRunId });
      if (!result.ok) {
        setError(describeError(result.code));
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        disabled={submitting}
        onClick={() => void handleRerun()}
      >
        <RefreshCw aria-hidden="true" />
        {submitting ? "Redelivering…" : "Rerun distribution"}
      </Button>
      <p className="text-body-sm text-muted-foreground">
        Redelivers only the failed artifacts. Posted invoices are never touched.
      </p>
      {error && (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function describeError(code: string): string {
  switch (code) {
    case "NOT_RERUNNABLE":
      return "This run is no longer eligible for a distribution rerun.";
    case "NO_FAILED_ARTIFACTS":
      return "Nothing is currently marked failed — refresh to see the latest state.";
    case "ENGINE_UNREACHABLE":
      return "The distribution engine could not be reached. Try again shortly.";
    case "FORBIDDEN":
      return "You do not have permission to rerun distribution.";
    case "VALIDATION_ERROR":
      return "Invalid request.";
    default:
      return "Something went wrong. Please try again.";
  }
}
