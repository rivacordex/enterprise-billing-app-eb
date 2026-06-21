"use client";

import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Pencil } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { updateConfigAction } from "@/actions/system-config/update-config.action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

interface ConfigEditDialogProps {
  configId: string;
  configKey: string;
  configGroup: string;
  initialValue: string | null;
}

type ConfigEditErrorCode =
  | "NOT_FOUND"
  | "SECRET_ROW"
  | "FORBIDDEN"
  | "SERVER_ERROR";

const ERROR_MESSAGES: Record<ConfigEditErrorCode, string> = {
  NOT_FOUND:
    "Configuration parameter not found. It may have been modified by another admin.",
  SECRET_ROW: "This parameter is marked secret and cannot be edited here.",
  FORBIDDEN: "You don't have permission to edit configuration parameters.",
  SERVER_ERROR: "Something went wrong. Please try again.",
};

const configValueFormSchema = z.object({
  configValue: z.string().max(2000, "Value must be 2000 characters or fewer"),
});

type ConfigValueFormValues = z.infer<typeof configValueFormSchema>;

// um23-spec §23.6.1. A self-contained Client Component leaf — owns both the
// trigger icon button and the `Dialog` — that `ConfigTable` (a Server
// Component) renders in each data row's Actions cell.
export function ConfigEditDialog({
  configId,
  configKey,
  configGroup,
  initialValue,
}: ConfigEditDialogProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<ConfigEditErrorCode | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ConfigValueFormValues>({
    resolver: zodResolver(configValueFormSchema),
    defaultValues: { configValue: initialValue ?? "" },
  });

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    if (!nextOpen) {
      setError(null);
      reset({ configValue: initialValue ?? "" });
    }
    setOpen(nextOpen);
  }

  async function onSubmit(values: ConfigValueFormValues): Promise<void> {
    setIsSubmitting(true);
    setError(null);

    const trimmed = values.configValue.trim();
    const coerced = trimmed === "" ? null : trimmed;

    try {
      const result = await updateConfigAction({
        configId,
        configValue: coerced,
      });

      if (result.ok) {
        setOpen(false);
        toast.success("Configuration updated.");
      } else if (result.code === "VALIDATION_ERROR") {
        // result.fieldErrors is intentionally discarded: configValueFormSchema
        // above mirrors updateConfigValueSchema's configValue rule exactly, so
        // this path is only reachable via a stale/forged configId (a uuid
        // check the form has no field for) — not a user-actionable validation.
        setError("SERVER_ERROR");
      } else {
        setError(result.code);
      }
    } catch {
      setError("SERVER_ERROR");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Edit configuration value"
        className="rounded-sm p-1 text-muted-foreground outline-none hover:bg-[color:var(--action-ghost-hover)] hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)]"
      >
        <Pencil size={14} />
      </button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit configuration</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground">Group</span>
            <span className="font-mono text-foreground">{configGroup}</span>
            <span className="text-muted-foreground">Key</span>
            <span className="font-mono text-foreground">{configKey}</span>
          </div>

          <form
            id="config-edit-form"
            noValidate
            onSubmit={(e) => void handleSubmit(onSubmit)(e)}
          >
            <Field>
              <FieldLabel htmlFor="config-value">Value</FieldLabel>
              <Textarea
                id="config-value"
                rows={4}
                placeholder="Enter value…"
                className="font-mono text-sm"
                aria-invalid={!!errors.configValue}
                disabled={isSubmitting}
                {...register("configValue")}
              />
              <FieldError errors={[errors.configValue]} />
            </Field>
          </form>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{ERROR_MESSAGES[error]}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="config-edit-form"
              disabled={isSubmitting}
            >
              {isSubmitting && <Loader2 className="animate-spin" size={14} />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
