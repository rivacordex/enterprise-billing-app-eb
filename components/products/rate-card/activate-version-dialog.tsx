"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { activateRatecardVersionAction } from "@/actions/product/activate-ratecard-version.action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// pm66-spec D6 — the page's ONE `--action-cta-bg` (C10, settled: the CTA is
// "Activate version", not "Upload new version" — activation is the single act
// with billing consequence; record creation takes `--action-primary-bg`).
// A PLAIN confirmation, not danger (§7's Activate-confirmation construction),
// and not a bare "Are you sure": above the confirm control it names the version
// being superseded and shows the added/changed/removed counts.
//
// There is NO carry-forward summary (D-A7): activation is two status flips and
// writes no rows, so the counts are the whole consequence. The counts SHOWN
// come from pm62 via the server (the page); the counts RECORDED come from pm63
// inside the transaction — they can differ if the card changed between render
// and click, which is exactly why the audit records its own (D6). Every refusal
// renders from the typed result (D10).

export interface RateCardChangeCounts {
  added: number;
  changed: number;
  removed: number;
}

export interface ActivateVersionDialogProps {
  trigger: React.ReactNode;
  versionId: string;
  versionNum: number;
  // The current ACTIVE version this activation would supersede (null on the
  // card's first-ever activation).
  supersededVersionId: string | null;
  counts: RateCardChangeCounts;
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

export function ActivateVersionDialog({
  trigger,
  versionId,
  versionNum,
  supersededVersionId,
  counts,
}: ActivateVersionDialogProps): React.JSX.Element {
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
      const result = await activateRatecardVersionAction(versionId);
      if (result.ok) {
        setOpen(false);
        toast.success(
          result.supersededVersionId
            ? "Version activated — the previous version is now superseded."
            : "Version activated.",
        );
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "CONCURRENT_ACTIVATION_CONFLICT") {
        toast.error("Another activation just happened. Refreshing…");
        setOpen(false);
        router.refresh();
      } else if (
        result.code === "NOT_DRAFT" ||
        result.code === "VERSION_NOT_FOUND"
      ) {
        toast.error("This version can no longer be activated. Refreshing…");
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
          <DialogTitle>Activate version</DialogTitle>
        </DialogHeader>

        <p className="text-body-sm text-muted-foreground">
          <span className="font-mono text-mono">{versionId}</span> (v
          {versionNum}) becomes the live version for this card.{" "}
          {supersededVersionId ? (
            <>
              The version currently active,{" "}
              <span className="font-mono text-mono">{supersededVersionId}</span>
              , becomes superseded — its rows stay readable for rollback.
            </>
          ) : (
            <>This card has no active version yet.</>
          )}
        </p>

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
            Activate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
