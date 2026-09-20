"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import { returnToDraftAction } from "@/actions/product/return-to-draft.action";
import { updateOfferingAction } from "@/actions/product/update-offering.action";
import { ActivateOfferingDialog } from "@/components/products/manage/activate-offering-dialog";
import { buildManageProductsHref } from "@/components/products/manage/manage-products-href";
import { OfferingForm } from "@/components/products/manage/offering-form";
import { SubmitForTestingDialog } from "@/components/products/manage/submit-for-testing-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  VERSION_HEADER_ACTIONS_BY_STATUS,
  type LifecycleStatus,
  type OfferingDetail,
} from "@/types/product";
import type { UpdateOfferingInput } from "@/validation/product/update-offering.schema";

// pm41 D4 + pm42 I6. The version-level actions in the selected version's header,
// their visibility read from the total VERSION_HEADER_ACTIONS_BY_STATUS Record
// (never inline `status === …` comparisons) so a new lifecycle status forces a
// decision here (code-standards §2.2). DRAFT: Edit (in place) + Submit for
// testing. TESTING: Back to draft + Activate. ACTIVE: Edit (branch-first, then
// navigate to the new draft's ?version=). OBSOLETE/RETIRED: nothing. The
// "creates a new draft" banner lives inside the reused OfferingForm.
const TOUCH_TARGET = "[@media(pointer:coarse)]:min-h-[44px]";

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
  const [isReturning, setIsReturning] = useState(false);

  const actions = VERSION_HEADER_ACTIONS_BY_STATUS[offering.lifecycleStatus];
  if (actions.length === 0) {
    return null;
  }

  // Edit is offered only on DRAFT and ACTIVE (the Record); the narrow union is
  // what OfferingForm's edit mode accepts.
  const editableStatus: "DRAFT" | "ACTIVE" =
    offering.lifecycleStatus === "ACTIVE" ? "ACTIVE" : "DRAFT";

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

  async function handleReturnToDraft(): Promise<void> {
    setIsReturning(true);
    try {
      const result = await returnToDraftAction(offering.productOfferingId, {});
      if (result.ok) {
        toast.success("Returned to draft");
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_NOT_TESTING") {
        toast.error("This version is no longer in testing. Refreshing...");
        router.refresh();
      } else if (result.code === "OFFERING_NOT_FOUND") {
        toast.error("This offering no longer exists. Refreshing...");
        router.refresh();
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsReturning(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {actions.includes("returnToDraft") ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={TOUCH_TARGET}
          disabled={isReturning}
          onClick={() => void handleReturnToDraft()}
        >
          {isReturning && <Loader2 size={14} className="animate-spin" />}
          Back to draft
        </Button>
      ) : null}

      {actions.includes("submitForTesting") ? (
        <SubmitForTestingDialog
          offeringId={offering.productOfferingId}
          offeringName={offering.name}
          offeringVersion={offering.version}
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={TOUCH_TARGET}
            >
              Submit for testing
            </Button>
          }
        />
      ) : null}

      {actions.includes("activate") ? (
        <ActivateOfferingDialog
          offeringId={offering.productOfferingId}
          offeringName={offering.name}
          offeringVersion={offering.version}
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={TOUCH_TARGET}
            >
              Activate
            </Button>
          }
        />
      ) : null}

      {actions.includes("edit") ? (
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={TOUCH_TARGET}
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
      ) : null}
    </div>
  );
}
