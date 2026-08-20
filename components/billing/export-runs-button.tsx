"use client";

import { Download } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { exportRunsAction } from "@/actions/billing/export-runs.action";

// bm02-spec §6/§7. Client control that calls the CSV export Server Action for
// the currently-filtered view and triggers a `Blob` download — no Route
// Handler. Reads the live filter params from the URL so the export always
// matches what is on screen.

interface ExportRunsButtonProps {
  tab: "current" | "historical";
}

export function ExportRunsButton({
  tab,
}: ExportRunsButtonProps): React.JSX.Element {
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);

  async function handleExport(): Promise<void> {
    setPending(true);
    try {
      const result = await exportRunsAction({
        tab,
        cycle: searchParams.get("cycle"),
        status: searchParams.get("status"),
      });

      if (!result.ok) {
        toast.error("You do not have permission to export bill runs.");
        return;
      }

      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Defer revocation so the browser can initiate the download first — a
      // synchronous revoke can cancel a larger download (matches
      // components/accounts/journal-export-button.tsx).
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      toast.error(
        "Something went wrong exporting bill runs. Please try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="outline"
      onClick={handleExport}
      disabled={pending}
      className="gap-1.5"
    >
      <Download size={14} aria-hidden="true" />
      {pending ? "Exporting…" : "Export CSV"}
    </Button>
  );
}
