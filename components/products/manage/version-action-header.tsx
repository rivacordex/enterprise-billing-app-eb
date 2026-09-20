"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { toast } from "sonner";

import { updateOfferingAction } from "@/actions/product/update-offering.action";
import { buildManageProductsHref } from "@/components/products/manage/manage-products-href";
import { OfferingForm } from "@/components/products/manage/offering-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LifecycleStatus, OfferingDetail } from "@/types/product";
import type { UpdateOfferingInput } from "@/validation/product/update-offering.schema";

// pm41 D4. The offering-level Edit affordance in the selected version's header.
// On a DRAFT it edits the offering fields in place; on an ACTIVE version the
// panels themselves are never editable — this Edit calls updateOfferingAction
// (branch-first, as today) and the page then navigates to the new draft's
// ?version=. The "this creates a new draft" banner lives inside the reused
// OfferingForm (ui-context §7 — shown before the branch happens). The Edit
// affordance appears only on DRAFT and ACTIVE (ui-context §7); TESTING's
// return-to-draft, OBSOLETE's retire and DRAFT/TESTING's discard are later
// units, so this header renders nothing for those statuses.
export interface VersionActionHeaderProps {
  offering: OfferingDetail;
  familyId: string;
  // Carried through so the branch navigation preserves the list state; the page
  // always supplies definite values (parsed searchParams), so these are required
  // rather than optional-and-undefined.
  query: string;
  status: LifecycleStatus | null;
  page: number;
}

export function VersionActionHeader({
  offering,
  familyId,
  query,
  status,
  page,
}: VersionActionHeaderProps): React.JSX.Element | null {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Only DRAFT and ACTIVE carry an Edit affordance (ui-context §7). The narrow
  // union is what OfferingForm's edit mode accepts.
  const editableStatus: "DRAFT" | "ACTIVE" | null =
    offering.lifecycleStatus === "DRAFT"
      ? "DRAFT"
      : offering.lifecycleStatus === "ACTIVE"
        ? "ACTIVE"
        : null;

  if (editableStatus === null) {
    return null;
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    setOpen(nextOpen);
  }

  async function handleSubmit(values: UpdateOfferingInput): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await updateOfferingAction(
        offering.productOfferingId,
        values,
      );

      if (result.ok) {
        setOpen(false);
        if (result.branched) {
          toast.success("New draft version created");
          // Land the user on the freshly-branched draft (D4).
          router.push(
            buildManageProductsHref({
              q: query,
              status,
              page,
              family: familyId,
              version: result.offeringId,
            }),
          );
        } else {
          toast.success("Offering updated");
          router.refresh();
        }
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_RETIRED") {
        toast.error(
          "This offering has been retired and can no longer be edited.",
        );
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="[@media(pointer:coarse)]:min-h-[44px]"
        aria-label="Edit"
        onClick={() => setOpen(true)}
      >
        <Pencil size={14} aria-hidden />
        Edit
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {offering.name}</DialogTitle>
        </DialogHeader>

        <OfferingForm
          mode="edit"
          offeringName={offering.name}
          currentStatus={editableStatus}
          defaultValues={{
            name: offering.name,
            isSellable: offering.isSellable,
            billingOnly: offering.billingOnly,
          }}
          onSubmit={handleSubmit}
          onCancel={() => handleOpenChange(false)}
          isSubmitting={isSubmitting}
        />
      </DialogContent>
    </Dialog>
  );
}
