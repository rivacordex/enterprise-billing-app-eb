"use client";

import { useEffect } from "react";

import { reportError } from "@/lib/logger";

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}): React.JSX.Element {
  useEffect(() => {
    reportError(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="rounded-lg border border-border bg-card p-8 text-center shadow-md">
        <h2 className="text-h3 font-semibold text-foreground">
          Something went wrong
        </h2>
        <p className="mt-2 text-body text-muted-foreground">
          An unexpected error occurred. Please try again.
        </p>
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="mt-4 rounded-sm bg-primary px-4 py-2 text-body font-medium text-primary-foreground hover:bg-primary/80"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
