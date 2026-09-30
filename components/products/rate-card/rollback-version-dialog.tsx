"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { rollbackRatecardVersionAction } from "@/actions/product/rollback-ratecard-version.action";
import {
  CountsStrip,
  type RateCardChangeCounts,
} from "@/components/products/rate-card/activate-version-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// pm66-spec D7 — a PLAIN confirmation, NOT danger: versions are immutable, so
// nothing is lost and the move is itself reversible (ui-context §10.6). It names
// the version being demoted and repeats the same counts COMPUTED IN THE OTHER
// DIRECTION (target against current ACTIVE — pm62 D6, pm64 D4). Confirm in
// `--action-cta-bg` inside the dialog; Activate and Roll back never co-render (a
// version cannot be both DRAFT and SUPERSEDED), so the one-accent-per-view rule
// holds (D7). Every refusal renders from the typed result (D10).

export interface RollbackVersionDialogProps {
  trigger: React.ReactNode;
  versionId: string;
  versionNum: number;
  // The current ACTIVE version this rollback would demote (null when the card
  // has no active version — the rollback simply promotes the target).
  demotedVersionId: string | null;
  counts: RateCardChangeCounts;
}

export function RollbackVersionDialog({
  trigger,
  versionId,
  versionNum,
  demotedVersionId,
  counts,
}: RollbackVersionDialogProps): React.JSX.Element {
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
      const result = await rollbackRatecardVersionAction(versionId);
      if (result.ok) {
        setOpen(false);
        toast.success(
          result.supersededVersionId
            ? "Rolled back — the current version is now superseded."
            : "Rolled back.",
        );
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "CONCURRENT_ACTIVATION_CONFLICT") {
        toast.error("Another activation just happened. Refreshing…");
        setOpen(false);
        router.refresh();
      } else if (
        result.code === "NOT_SUPERSEDED" ||
        result.code === "VERSION_NOT_FOUND"
      ) {
        toast.error("This version can no longer be rolled back. Refreshing…");
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
          <DialogTitle>Roll back to this version</DialogTitle>
        </DialogHeader>

        <p className="text-body-sm text-muted-foreground">
          <span className="font-mono text-mono">{versionId}</span> (v
          {versionNum}) becomes the live version again.{" "}
          {demotedVersionId ? (
            <>
              The version currently active,{" "}
              <span className="font-mono text-mono">{demotedVersionId}</span>,
              becomes superseded — nothing is lost, and this move is itself
              reversible.
            </>
          ) : (
            <>This card has no active version to demote.</>
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
            Roll back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { RateCardChangeCounts };
