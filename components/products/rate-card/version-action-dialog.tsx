"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// pm66 D6/D7 — the shared shell for the two rate-card version confirmations.
// `ActivateVersionDialog` and `RollbackVersionDialog` are near-identical PLAIN
// (not danger) confirmations: each names the other version, shows the
// added/changed/removed counts, and confirms in `--action-cta-bg` (the two
// never co-render, so the one-accent-per-view rule holds). They differ only in
// copy, the action they call, the success text, and which "stale" codes send
// the user back to a refresh. This shell owns the shared open/submitting state,
// the result-handling skeleton and the JSX; the two exported dialogs stay thin
// wrappers over it (the binding names in §4.23 are the wrappers, not this).
// Extracted after a duplication finding — the two dialogs were ~90% identical.

export interface RateCardChangeCounts {
  added: number;
  changed: number;
  removed: number;
}

export function CountsStrip({
  counts,
}: {
  counts: RateCardChangeCounts;
}): React.JSX.Element {
  return (
    <dl className="grid grid-cols-3 gap-2 rounded-md bg-[color:var(--surface-sunken)] p-3 text-center">
      {(
        [
          ["Added", counts.added],
          ["Changed", counts.changed],
          ["Removed", counts.removed],
        ] as const
      ).map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-overline tracking-wider text-muted-foreground uppercase">
            {label}
          </dt>
          <dd className="text-h4 font-semibold text-foreground tabular-nums">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// The minimal result shape this shell reads — both the activate and rollback
// action results are structurally assignable to it (ok carries the
// superseded/demoted id; a refusal carries a typed `code`). Every refusal
// renders from this typed result, never from client state (D10).
export interface VersionActionResult {
  ok: boolean;
  supersededVersionId?: string | null;
  code?: string;
}

export interface VersionActionDialogProps {
  trigger: React.ReactNode;
  title: string;
  confirmLabel: string;
  // The descriptive line above the counts (the version being promoted and what
  // it supersedes/demotes). Built by the wrapper so each keeps its own copy.
  body: React.ReactNode;
  counts: RateCardChangeCounts;
  // The bound action call (the wrapper closes over its own versionId). Runs on
  // the client, so the wrappers must be `"use client"`.
  action: () => Promise<VersionActionResult>;
  successMessage: (otherVersionId: string | null | undefined) => string;
  // Codes meaning "the version moved under you" (e.g. NOT_DRAFT /
  // NOT_SUPERSEDED / VERSION_NOT_FOUND): show the message, close, and refresh so
  // the list re-renders. Any other refusal is an unexpected error (try again).
  staleCodes: readonly string[];
  staleMessage: string;
}

export function VersionActionDialog({
  trigger,
  title,
  confirmLabel,
  body,
  counts,
  action,
  successMessage,
  staleCodes,
  staleMessage,
}: VersionActionDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleOpenChange(next: boolean): void {
    if (isSubmitting) return;
    setOpen(next);
  }

  async function handleConfirm(): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await action();
      if (result.ok) {
        setOpen(false);
        toast.success(successMessage(result.supersededVersionId));
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "CONCURRENT_ACTIVATION_CONFLICT") {
        toast.error("Another activation just happened. Refreshing…");
        setOpen(false);
        router.refresh();
      } else if (
        result.code !== undefined &&
        staleCodes.includes(result.code)
      ) {
        toast.error(staleMessage);
        setOpen(false);
        router.refresh();
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <p className="text-body-sm text-muted-foreground">{body}</p>

        <CountsStrip counts={counts} />

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={isSubmitting}
            onClick={() => void handleConfirm()}
            className="bg-[color:var(--action-cta-bg)]"
          >
            {isSubmitting && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
