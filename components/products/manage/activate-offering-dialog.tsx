"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { activateOfferingAction } from "@/actions/product/activate-offering.action";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

export interface ActivateOfferingDialogProps {
  trigger: React.ReactNode;
  offeringId: string;
  offeringName: string;
  // Design §2.6 — lets ManageOfferingTable auto-expand the family so the
  // just-superseded sibling is visible without a further click. Called only
  // when the action's result carries a non-null supersededOfferingId.
  onSuperseded: () => void;
}

type PreconditionErrorCode = "NO_PRICE_ROWS" | "SPECIFICATIONS_NOT_RESOLVED";

// Design §2.5 — the two named, expected precondition failures get a
// persistent inline Alert, not a transient toast.
function preconditionMessage(code: PreconditionErrorCode): string {
  return code === "NO_PRICE_ROWS"
    ? "This draft has no prices yet. Add at least one price before activating."
    : "This draft has an unresolved mandatory specification. Set a value for every mandatory specification before activating.";
}

export function ActivateOfferingDialog({
  trigger,
  offeringId,
  offeringName,
  onSuperseded,
}: ActivateOfferingDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [preconditionError, setPreconditionError] =
    useState<PreconditionErrorCode | null>(null);

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    if (nextOpen) {
      setReason("");
      setPreconditionError(null);
    }
    setOpen(nextOpen);
  }

  async function handleActivateConfirm(): Promise<void> {
    setIsSubmitting(true);
    setPreconditionError(null);
    try {
      const result = await activateOfferingAction(offeringId, { reason });

      if (result.ok) {
        setOpen(false);
        if (result.supersededOfferingId) {
          toast.success("Offering activated — previous version retired");
          onSuperseded();
        } else {
          toast.success("Offering activated");
        }
        router.refresh();
      } else if (
        result.code === "NO_PRICE_ROWS" ||
        result.code === "SPECIFICATIONS_NOT_RESOLVED"
      ) {
        setPreconditionError(result.code);
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_NOT_FOUND") {
        toast.error("This offering no longer exists. Refreshing...");
        setOpen(false);
        router.refresh();
      } else {
        // OFFERING_NOT_DRAFT / VALIDATION_ERROR / SERVER_ERROR — unreachable
        // via any shipped seam (pm18 only ever renders Activate on a DRAFT
        // row); handled defensively, not assumed impossible, mirroring
        // pm20/pm22's identical stance on their own unreachable branches.
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
          <DialogTitle>Activate offering</DialogTitle>
        </DialogHeader>

        <p className="text-body-sm text-muted-foreground">
          <strong>{offeringName}</strong> will become billable once activated.
          Requires at least one price and all mandatory specs resolved. If
          another version of this product is currently active, it will be
          retired automatically.
        </p>

        {preconditionError && (
          <Alert variant="destructive">
            <AlertDescription>
              {preconditionMessage(preconditionError)}
            </AlertDescription>
          </Alert>
        )}

        <Field>
          <FieldLabel htmlFor="activate-reason">Reason (optional)</FieldLabel>
          <Textarea
            id="activate-reason"
            rows={2}
            maxLength={500}
            placeholder="Q3 rate refresh"
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
          {/* ui-context-phase2's "Activate confirmation" section: accent-
              filled — the one place besides "New offering" an accent button
              may appear, since the two never render in the same view. */}
          <Button
            type="button"
            disabled={isSubmitting}
            onClick={() => void handleActivateConfirm()}
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
