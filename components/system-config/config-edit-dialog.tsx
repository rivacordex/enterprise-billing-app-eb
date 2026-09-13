"use client";

import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Pencil } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { updateConfigAction } from "@/actions/system-config/update-config.action";
import {
  CONFIG_VALUE_MAX_LENGTH,
  configValueLength,
} from "@/lib/config-limits";
import { cn } from "@/lib/utils";
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
  // D12: the per-key VALUE_TOO_LONG rejection is a field error, not a generic
  // Alert — the problem is the value itself, shown under the textarea.
  const [fieldError, setFieldError] = useState<string | null>(null);

  // D12: per-key length budget (e.g. app/app_name → 40). Undefined for every
  // other row, which renders without a counter. Counted in Unicode code points
  // (not UTF-16 units) to match the "N characters" contract and the server
  // check, so an emoji/astral glyph counts as one.
  const lengthLimit = CONFIG_VALUE_MAX_LENGTH[`${configGroup}:${configKey}`];

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ConfigValueFormValues>({
    resolver: zodResolver(configValueFormSchema),
    defaultValues: { configValue: initialValue ?? "" },
  });

  // The length that counts toward the budget is the TRIMMED, code-point length
  // — exactly what the dialog stores (onSubmit trims + coerces "" → null) and
  // what the server validates (both via `configValueLength`) — so the counter
  // never overstates the stored value (e.g. trailing spaces don't inflate it).
  // Tracked without react-hook-form's `watch()` (its returned fn the React
  // Compiler can't memoize); the field's own onChange is wrapped below.
  const measure = (v: string): number => configValueLength(v.trim());
  const initialLength = measure(initialValue ?? "");
  const [currentLength, setCurrentLength] = useState(initialLength);
  const valueField = register("configValue");
  const isOverLimit = lengthLimit !== undefined && currentLength > lengthLimit;

  function handleOpenChange(nextOpen: boolean): void {
    if (isSubmitting) return;
    // Re-sync the field, counter, and errors to the CURRENT stored value on
    // every open AND close — so reopening after a prior edit (or after another
    // admin changed the row and the list revalidated) never shows a stale value,
    // count, or lingering rejection. `useState` seeds only the first mount.
    setError(null);
    setFieldError(null);
    setCurrentLength(initialLength);
    reset({ configValue: initialValue ?? "" });
    setOpen(nextOpen);
  }

  async function onSubmit(values: ConfigValueFormValues): Promise<void> {
    setIsSubmitting(true);
    setError(null);
    setFieldError(null);

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
      } else if (result.code === "VALUE_TOO_LONG") {
        // D12: surfaced as a field error below the textarea. The live counter
        // warns before submit; the server remains the enforcement boundary.
        setFieldError(`Value must be ${result.limit} characters or fewer.`);
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
        onClick={() => handleOpenChange(true)}
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
                aria-invalid={!!errors.configValue || !!fieldError}
                aria-describedby={fieldError ? "config-value-error" : undefined}
                disabled={isSubmitting}
                {...valueField}
                onChange={(e) => {
                  void valueField.onChange(e);
                  setCurrentLength(measure(e.target.value));
                  // Clear a prior too-long rejection as soon as the value
                  // changes, so a stale error doesn't linger over a now-valid
                  // value (no native maxLength caps code points, so the counter
                  // + server are the guard).
                  if (fieldError) setFieldError(null);
                }}
              />
              <FieldError errors={[errors.configValue]} />
              {/* D12: field-level rejection + a live counter for capped keys so
                  the limit is visible before submit. */}
              {fieldError && (
                <p
                  id="config-value-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {fieldError}
                </p>
              )}
              {lengthLimit !== undefined && (
                <p
                  className={cn(
                    "text-right text-xs tabular-nums",
                    currentLength > lengthLimit
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {currentLength}/{lengthLimit}
                </p>
              )}
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
              disabled={isSubmitting || isOverLimit}
              title={
                isOverLimit
                  ? `Value must be ${lengthLimit} characters or fewer.`
                  : undefined
              }
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
