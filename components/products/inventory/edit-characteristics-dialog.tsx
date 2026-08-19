"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormProvider, useForm } from "react-hook-form";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { updateCharacteristicsAction } from "@/actions/inventory/update-characteristics.action";
import {
  CharacteristicsEditor,
  listToRecord,
  recordToList,
} from "@/components/products/ordering/characteristics-editor";
import type { WizardFormValues } from "@/components/products/ordering/wizard-form-types";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

function messageForCode(code: string): string {
  switch (code) {
    case "SUBSCRIPTION_NOT_FOUND":
      return "This subscription no longer exists. Refreshing…";
    case "SUBSCRIPTION_TERMINATED":
      return "This subscription has been terminated and can no longer be edited.";
    case "FORBIDDEN":
      return "You don't have permission to do that.";
    case "VALIDATION_ERROR":
      return "Please check your input and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export interface EditCharacteristicsDialogProps {
  trigger: React.ReactNode;
  inventoryId: string;
  characteristics: Record<string, string> | null;
}

function defaultFormValues(
  characteristics: Record<string, string> | null,
): WizardFormValues {
  return {
    quantity: 0,
    startDate: "",
    characteristicsList: recordToList(characteristics ?? {}),
    overrides: [],
  };
}

// pm33-spec §Implementation-2. Reuses pm29's `CharacteristicsEditor`
// unmodified against `instance_characteristics` — the editor is typed
// against `WizardFormValues` (its wizard-step host's own shape), so this
// dialog satisfies that shape with a form instance of its own; only
// `characteristicsList` is ever read from or written into it —
// quantity/startDate/overrides are unused placeholders, never rendered or
// submitted by this dialog.
export function EditCharacteristicsDialog({
  trigger,
  inventoryId,
  characteristics,
}: EditCharacteristicsDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const methods = useForm<WizardFormValues>({
    defaultValues: defaultFormValues(characteristics),
  });

  function handleOpenChange(next: boolean): void {
    if (isSubmitting) return;
    if (next) {
      methods.reset(defaultFormValues(characteristics));
    }
    setOpen(next);
  }

  async function onSubmit(values: WizardFormValues): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await updateCharacteristicsAction({
        inventoryId,
        characteristics: listToRecord(values.characteristicsList),
      });
      if (result.ok) {
        setOpen(false);
        toast.success("Characteristics updated");
        router.refresh();
      } else {
        toast.error(messageForCode(result.code));
        if (
          result.code === "SUBSCRIPTION_NOT_FOUND" ||
          result.code === "SUBSCRIPTION_TERMINATED"
        ) {
          setOpen(false);
          router.refresh();
        }
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
          <DialogTitle>Edit characteristics</DialogTitle>
        </DialogHeader>

        <p className="text-body-sm text-muted-foreground">
          This edit never affects pricing — characteristics are descriptive only
          and are never a rating input.
        </p>

        <FormProvider {...methods}>
          <CharacteristicsEditor isSubmitting={isSubmitting} />
        </FormProvider>

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
            type="button"
            disabled={isSubmitting}
            onClick={() => void methods.handleSubmit(onSubmit)()}
          >
            {isSubmitting && (
              <Loader2 size={14} className="mr-1 animate-spin" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
