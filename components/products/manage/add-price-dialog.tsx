"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { insertPriceAction } from "@/actions/product/insert-price.action";
import { PriceForm } from "@/components/products/manage/price-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";

export interface AddPriceDialogProps {
  trigger: React.ReactNode;
  offeringId: string;
  offeringName: string;
  currentStatus: "DRAFT" | "ACTIVE";
  // Design §2.8 — lets ManageOfferingTable auto-expand the family when a
  // branch happens, without this component needing its own family-id
  // resolution or shared table state (mirrors pm20's editingRow-driven
  // auto-expand, adapted to this component's per-row-instance shape).
  onBranched: () => void;
}

export function AddPriceDialog({
  trigger,
  offeringId,
  offeringName,
  currentStatus,
  onBranched,
}: AddPriceDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    setOpen(nextOpen);
  }

  async function handleSubmit(values: InsertPriceInput): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await insertPriceAction(offeringId, values);

      if (result.ok) {
        setOpen(false);
        if (result.branched) {
          toast.success("Price added to new draft version");
          onBranched();
        } else {
          toast.success("Price added");
        }
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else if (result.code === "OFFERING_RETIRED") {
        toast.error(
          "This offering has been retired and prices can no longer be added.",
        );
      } else if (result.code === "OFFERING_NOT_FOUND") {
        toast.error("This offering no longer exists. Refreshing...");
        setOpen(false);
        router.refresh();
      } else if (result.code === "BACKDATED_START_TOO_FAR") {
        toast.error(
          "Start date is more than 3 days in the past and can no longer be used.",
        );
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const title =
    currentStatus === "ACTIVE"
      ? `Add price — creates new draft — ${offeringName}`
      : `Add price — ${offeringName}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <PriceForm
          offeringName={offeringName}
          currentStatus={currentStatus}
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
        />

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" form="price-form-add" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="animate-spin" />}
            Add price
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
