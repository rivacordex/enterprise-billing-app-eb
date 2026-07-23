"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { createOfferingAction } from "@/actions/product/create-offering.action";
import { OfferingForm } from "@/components/products/manage/offering-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { CreateOfferingInput } from "@/validation/product/create-offering.schema";

export interface CreateOfferingDialogProps {
  trigger: React.ReactNode;
}

export function CreateOfferingDialog({
  trigger,
}: CreateOfferingDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    setOpen(nextOpen);
  }

  async function handleSubmit(values: CreateOfferingInput): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await createOfferingAction(values);

      if (result.ok) {
        setOpen(false);
        toast.success("Offering created");
        // No query-string selection concept on this page (pm19-spec §2.4)
        // — a plain refresh re-fetches page.tsx's server data so the new
        // DRAFT row appears in ManageOfferingTable immediately.
        router.refresh();
      } else if (result.code === "FORBIDDEN") {
        toast.error("You don't have permission to do that.");
      } else {
        // VALIDATION_ERROR here means the client bypassed the form's own
        // zodResolver (shouldn't happen in normal use) — no field-level
        // wiring needed since the form already blocks invalid submits.
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
          <DialogTitle>New offering</DialogTitle>
        </DialogHeader>

        <OfferingForm
          mode="create"
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
          <Button
            type="submit"
            form="offering-form-create"
            disabled={isSubmitting}
          >
            {isSubmitting && <Loader2 className="animate-spin" />}
            Save offering
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
