"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { deleteOfferingAction } from "@/actions/product/delete-offering.action";
import { buildManageProductsHref } from "@/components/products/manage/manage-products-href";
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
import type { LifecycleStatus } from "@/types/product";

export interface DeleteVersionDialogProps {
  trigger: React.ReactNode;
  offeringId: string;
  offeringName: string;
  offeringVersion: number;
  // The counts come from the already-loaded panels (I5); the service reports the
  // actual numbers back on success.
  specificationCount: number;
  priceCount: number;
  // Carried so the dialog can navigate off the deleted ?version= on success (I3).
  query: string;
  status: LifecycleStatus | null;
  page: number;
}

// pm44-spec I5. Discard — a danger AlertDialog with a danger-role confirm.
// Copy verbatim from ui-context §7, stating the exact counts. On success the UI
// must not render a stale selection: navigate to the family's remaining primary
// version, or to the bare list when the family is now gone (I3). Optional Reason
// carried into the audit payload.
export function DeleteVersionDialog({
  trigger,
  offeringId,
  offeringName,
  offeringVersion,
  specificationCount,
  priceCount,
  query,
  status,
  page,
}: DeleteVersionDialogProps): React.JSX.Element {
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
      const result = await deleteOfferingAction(offeringId, { reason });

      if (result.ok) {
        setOpen(false);
        toast.success("Version discarded");
        // Navigate off the deleted version: to the family's remaining primary
        // version, or to the bare list when the family is gone (I3).
        router.push(
          result.familyRemains
            ? buildManageProductsHref({
                q: query,
                status,
                page,
                family: result.familyId,
              })
            : buildManageProductsHref({ q: query, status, page }),
        );
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_NOT_DELETABLE") {
        toast.error("This version can no longer be discarded. Refreshing...");
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
          <AlertDialogTitle>Discard version</AlertDialogTitle>
          <AlertDialogDescription>
            Discarding <strong>{offeringName}</strong> v{offeringVersion}{" "}
            deletes this version with its {specificationCount} specifications
            and {priceCount} prices. It never went live and this cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Field>
          <FieldLabel htmlFor="discard-reason">Reason (optional)</FieldLabel>
          <Textarea
            id="discard-reason"
            rows={2}
            maxLength={500}
            placeholder="Created by mistake"
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
            Discard version
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
