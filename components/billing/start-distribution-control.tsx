"use client";

// bm20-spec §Phase-2 review folds T2/D-T1/D-T3 — the INVOICED-pending state's
// primary control. Plain explicit-click, no confirm modal (matches the
// Post/Retry-failed precedent — `posting-progress-view.tsx` — this is a
// benign, resumable recovery/kickoff action, not a money-moving one).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";

import { startDistributionAction } from "@/actions/billing/start-distribution.action";
import { Button } from "@/components/ui/button";

export interface StartDistributionControlProps {
  billRunId: string;
}

export function StartDistributionControl({
  billRunId,
}: StartDistributionControlProps): React.JSX.Element {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await startDistributionAction({ billRunId });
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
        onClick={() => void handleStart()}
      >
        <Send aria-hidden="true" />
        {submitting ? "Starting…" : "Start distribution"}
      </Button>
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
    case "NOT_INVOICED":
      return "This run is not ready for distribution.";
    case "ALREADY_STARTED":
      return "Distribution has already started for this run — refresh to see progress.";
    case "ENGINE_UNREACHABLE":
      return "The distribution engine could not be reached. Try again shortly.";
    case "FORBIDDEN":
      return "You do not have permission to start distribution.";
    case "VALIDATION_ERROR":
      return "Invalid request.";
    default:
      return "Something went wrong. Please try again.";
  }
}
