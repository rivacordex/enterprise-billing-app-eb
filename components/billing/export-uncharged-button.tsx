"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { exportUnchargedAction } from "@/actions/billing/export-uncharged.action";
import { downloadCsv } from "@/lib/download";

// bm07-spec §Implementation §3. Client control that calls the Uncharged CSV
// export Server Action for this run and triggers a `Blob` download — no Route
// Handler (the bm02 `ExportRunsButton` precedent).

interface ExportUnchargedButtonProps {
  runId: string;
}

export function ExportUnchargedButton({
  runId,
}: ExportUnchargedButtonProps): React.JSX.Element {
  const [pending, setPending] = useState(false);

  async function handleExport(): Promise<void> {
    setPending(true);
    try {
      const result = await exportUnchargedAction({ runId });

      if (!result.ok) {
        toast.error(
          result.code === "FORBIDDEN"
            ? "You do not have permission to export uncharged accounts."
            : "Could not export uncharged accounts for this run.",
        );
        return;
      }

      downloadCsv(result.csv, result.filename);
    } catch {
      toast.error(
        "Something went wrong exporting uncharged accounts. Please try again.",
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
