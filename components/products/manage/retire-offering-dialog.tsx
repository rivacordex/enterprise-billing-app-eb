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
  // "DRAFT" -> Discard copy; "ACTIVE" -> Retire copy (ui-context-phase2's
  // one-component-two-copy-states table). pm18's own action matrix never
  // renders this dialog's trigger on a RETIRED row, so no third case exists.
  currentStatus: "DRAFT" | "ACTIVE";
}

// ui-context-phase2.md "Discard vs. Retire dialog" — exact copy, verbatim.
const COPY = {
  DRAFT: {
    title: "Discard draft",
    body: (name: string): string =>
      `Discarding ${name} removes this draft — it never went live and this cannot be undone.`,
    confirmLabel: "Discard draft",
    successToast: "Draft discarded",
  },
  ACTIVE: {
    title: "Retire offering",
    body: (name: string): string =>
      `Retiring ${name} hides it from new billing selection. This cannot be undone.`,
    confirmLabel: "Retire offering",
    successToast: "Offering retired",
  },
} as const;

// pm23-spec §3.5. One component, two copy states — code-standards-phase2 §4
// ("its copy/title switches between 'Retire' and 'Discard draft' based on
// the target's status — one component, not two") and §1 rule 11 (one
// repository call, one service, now one dialog — no re-fork anywhere in
// this stack). Structurally near-identical to delete-role-dialog.tsx, with
// an added optional Reason field (Design §2.2).
export function RetireOfferingDialog({
  trigger,
  offeringId,
  offeringName,
  currentStatus,
}: RetireOfferingDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const copy = COPY[currentStatus];

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    if (nextOpen) setReason("");
    setOpen(nextOpen);
  }

  async function handleConfirm(): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await retireOfferingAction(offeringId, { reason });

      if (result.ok) {
        setOpen(false);
        // Design §2.9 — eventType, not the currentStatus prop, drives the
        // toast: the server's own answer to "which one actually happened."
        toast.success(
          result.eventType === "PRODUCT_OFFERING_DISCARDED"
            ? COPY.DRAFT.successToast
            : COPY.ACTIVE.successToast,
        );
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_RETIRED") {
        toast.error("This offering has already been retired.");
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
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {copy.body(offeringName)}
          </AlertDialogDescription>
        </AlertDialogHeader>

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
            {copy.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
