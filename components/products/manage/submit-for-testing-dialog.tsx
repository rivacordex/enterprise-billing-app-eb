"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { submitForTestingAction } from "@/actions/product/submit-for-testing.action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export interface SubmitForTestingDialogProps {
  trigger: React.ReactNode;
  offeringId: string;
  offeringName: string;
  offeringVersion: number;
}

// pm42-spec D6. A plain confirmation, not a danger dialog: the version simply
// becomes read-only while in testing and is reversible to draft. Precondition
// failures (no prices, an unresolved mandatory spec) NEVER appear as dialog copy
// — they render as live hints at the panel that owns them (the prices panel, the
// spec's row). So on such a failure the dialog closes and refreshes, letting
// those hints surface, rather than restating the requirement here. The optional
// Reason is captured in the audit payload, never a column.
export function SubmitForTestingDialog({
  trigger,
  offeringId,
  offeringName,
  offeringVersion,
}: SubmitForTestingDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    if (nextOpen) {
      setReason("");
    }
    setOpen(nextOpen);
  }

  async function handleConfirm(): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await submitForTestingAction(offeringId, { reason });

      if (result.ok) {
        setOpen(false);
        toast.success("Submitted for testing");
        router.refresh();
      } else if (
        result.code === "NO_PRICE_ROWS" ||
        result.code === "SPECIFICATIONS_NOT_RESOLVED"
      ) {
        // Not dialog copy (D6): close and refresh so the panel hints — which are
        // live — tell the user exactly where to fix it.
        setOpen(false);
        router.refresh();
        toast.error("Resolve the highlighted requirements before submitting.");
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_NOT_DRAFT") {
        toast.error("This version is no longer a draft. Refreshing...");
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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit for testing</DialogTitle>
        </DialogHeader>

        <p className="text-body-sm text-muted-foreground">
          <strong>{offeringName}</strong> v{offeringVersion} becomes read-only
          while in testing. Return it to draft to make further changes.
        </p>

        <Field>
          <FieldLabel htmlFor="submit-testing-reason">
            Reason (optional)
          </FieldLabel>
          <Textarea
            id="submit-testing-reason"
            rows={2}
            maxLength={500}
            placeholder="Ready for review"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={isSubmitting}
          />
        </Field>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          {/* Quiet secondary — the featured-CTA accent is reserved for Activate
              (ui-context §9). */}
          <Button
            type="button"
            disabled={isSubmitting}
            onClick={() => void handleConfirm()}
          >
            {isSubmitting && <Loader2 className="animate-spin" />}
            Submit for testing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
