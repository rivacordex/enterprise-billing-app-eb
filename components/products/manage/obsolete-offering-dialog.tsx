"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { obsoleteOfferingAction } from "@/actions/product/obsolete-offering.action";
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

export interface ObsoleteOfferingDialogProps {
  trigger: React.ReactNode;
  offeringId: string;
  offeringName: string;
}

// pm43-spec I6. Stop selling (ACTIVE → OBSOLETE): a danger AlertDialog with a
// danger-role confirm (ui-context §7). Copy verbatim from ui-context §7 — the
// version stops being orderable but keeps billing its existing subscriptions.
// Optional Reason captured in the audit payload, never a column.
export function ObsoleteOfferingDialog({
  trigger,
  offeringId,
  offeringName,
}: ObsoleteOfferingDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    if (nextOpen) setReason("");
    setOpen(nextOpen);
  }

  async function handleConfirm(): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await obsoleteOfferingAction(offeringId, { reason });

      if (result.ok) {
        setOpen(false);
        toast.success("Stopped selling");
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_NOT_ACTIVE") {
        toast.error("This version is no longer active. Refreshing...");
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
          <AlertDialogTitle>Stop selling</AlertDialogTitle>
          <AlertDialogDescription>
            <strong>{offeringName}</strong> will stop being available for new
            orders. Existing subscriptions keep billing from this version
            unchanged.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Field>
          <FieldLabel htmlFor="obsolete-reason">Reason (optional)</FieldLabel>
          <Textarea
            id="obsolete-reason"
            rows={2}
            maxLength={500}
            placeholder="Replaced by the FY27 plan"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={isSubmitting}
          />
        </Field>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={isSubmitting}
            onClick={() => void handleConfirm()}
          >
            {isSubmitting && (
              <Loader2 size={14} className="mr-1 animate-spin" />
            )}
            Stop selling
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
