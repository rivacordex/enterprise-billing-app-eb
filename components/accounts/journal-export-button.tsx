"use client";

import { useState } from "react";

import { triggerBlobDownload } from "@/lib/download";

export interface JournalExportButtonProps {
  period: string;
  currency: string;
}

// ac14-spec §3.7 — export button: POSTs to /api/accounts/gl-journal-export and
// triggers a CSV file download. Uses fetch so the response stream can be
// captured as a Blob before handing it to the browser's download mechanism.
export function JournalExportButton({
  period,
  currency,
}: JournalExportButtonProps): React.JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/accounts/gl-journal-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, currency }),
      });

      if (!resp.ok) {
        const json = await resp
          .json()
          .catch(() => ({ error: "Unknown error" }));
        if (
          typeof json === "object" &&
          json !== null &&
          (json as { error?: string }).error === "UNBALANCED_JOURNAL"
        ) {
          const { totalDebit, totalCredit } = json as {
            totalDebit: string;
            totalCredit: string;
          };
          setError(
            `Cannot export: journal is unbalanced (debit ${totalDebit} ≠ credit ${totalCredit}).`,
          );
        } else if (resp.status === 403) {
          setError("You do not have permission to export the journal.");
        } else {
          setError("Export failed. Please try again.");
        }
        return;
      }

      const blob = await resp.blob();
      triggerBlobDownload(blob, `gl-journal-${period}-${currency}.csv`);
    } catch {
      setError("Export failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={loading}
        onClick={() => void handleExport()}
        className="rounded-sm border border-[color:var(--border-default)] bg-[color:var(--surface-card)] px-3 py-1.5 text-body-sm font-medium text-foreground hover:bg-[color:var(--surface-sunken)] focus:outline-none focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
      >
        {loading ? "Exporting…" : "Export CSV"}
      </button>
      {error && (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
