"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { retireOfferingAction } from "@/actions/product/retire-offering.action";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export interface RetireOfferingDialogProps {
  trigger: React.ReactNode;
  offeringId: string;
  offeringName: string;
  offeringVersion: number;
  // The page's own live-subscription count for this OBSOLETE version (pm43 I6/I7).
  // When > 0 the dialog shows the blocked message instead of a confirm button —
  // it never offers an action the gate will refuse. The server re-checks
  // regardless (D4), so a stale count only ever fails safe.
  liveCount: number;
}

// pm43-spec I6, re-purposed. Retire (OBSOLETE → RETIRED): shown on OBSOLETE only.
// A danger AlertDialog; copy verbatim from ui-context §7. When any subscription
// still bills from the version the confirm button is replaced by the blocked
// message naming the count.
export function RetireOfferingDialog({
  trigger,
  offeringId,
  offeringName,
  offeringVersion,
  liveCount,
}: RetireOfferingDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // A server-reported block (the count moved between the page read and the
  // confirm) surfaces here so the dialog can switch to the blocked message.
  const [blockedCount, setBlockedCount] = useState<number | null>(null);

  const effectiveBlocked = blockedCount ?? liveCount;
  const isBlocked = effectiveBlocked > 0;

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    if (nextOpen) {
      setReason("");
      setBlockedCount(null);
    }
    setOpen(nextOpen);
  }

  async function handleConfirm(): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await retireOfferingAction(offeringId, { reason });

      if (result.ok) {
        setOpen(false);
        toast.success("Version retired");
        router.refresh();
      } else if (result.code === "RETIRE_BLOCKED_BY_SUBSCRIPTIONS") {
        // The gate moved under us — switch to the blocked message in place.
        setBlockedCount(result.liveCount);
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_NOT_OBSOLETE") {
        toast.error("This version can no longer be retired. Refreshing...");
        setOpen(false);
        router.refresh();
      } else if (result.code === "OFFERING_NOT_FOUND") {
        toast.error("This offering no longer exists. Refreshing...");
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
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Retire version</AlertDialogTitle>
          <AlertDialogDescription>
            {isBlocked ? (
              <>
                {effectiveBlocked} subscription
                {effectiveBlocked === 1 ? "" : "s"} still{" "}
                {effectiveBlocked === 1 ? "bills" : "bill"} from this version.
                It can be retired once they end.
              </>
            ) : (
              <>
                No subscription depends on <strong>{offeringName}</strong> v
                {offeringVersion} any more. Retiring is final.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {!isBlocked ? (
          <Field>
            <FieldLabel htmlFor="retire-reason">Reason (optional)</FieldLabel>
            <Textarea
              id="retire-reason"
              rows={2}
              maxLength={500}
              placeholder="Superseded by the new rate plan"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={isSubmitting}
            />
          </Field>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSubmitting}>
            {isBlocked ? "Close" : "Cancel"}
          </AlertDialogCancel>
          {!isBlocked ? (
            <Button
              type="button"
              variant="destructive"
              disabled={isSubmitting}
              onClick={() => void handleConfirm()}
            >
              {isSubmitting && (
                <Loader2 size={14} className="mr-1 animate-spin" />
              )}
              Retire version
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
