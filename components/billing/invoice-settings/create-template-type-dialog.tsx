"use client";

// bm77-spec §8 (code-standards › Invoice Template Types, Next.js rule 4) —
// `CreateTemplateTypeDialog`: one Name field, Create (primary) and Cancel. It
// keeps no server state: on success it navigates to the new type's detail
// page; on `ok: false` it shows the name's field error under the input in
// Danger `-fg` (or a generic message). The client-side trim + length check only
// enables Create (UX); the service normalizes and validates authoritatively.

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createTemplateTypeAction } from "@/actions/billing/invoice-settings/create-template-type.action";
import { TEMPLATE_TYPE_MESSAGES } from "@/components/billing/invoice-settings/template-type-messages";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const NAME_MIN = 3;
const NAME_MAX = 60;
const DETAIL_BASE = "/administration/invoice-settings/invoice-template";

export function CreateTemplateTypeDialog(): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trimmedLength = name.trim().replace(/\s+/g, " ").length;
  const canCreate =
    trimmedLength >= NAME_MIN && trimmedLength <= NAME_MAX && !submitting;

  function handleOpenChange(next: boolean): void {
    if (submitting) return;
    setOpen(next);
    if (!next) {
      setName("");
      setError(null);
    }
  }

  async function create(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await createTemplateTypeAction({ name });
      if (result.ok) {
        setOpen(false);
        router.push(`${DETAIL_BASE}/${result.typeId}`);
        return;
      }
      setError(
        result.fieldErrors?.name?.[0] ??
          (result.code === "FORBIDDEN"
            ? TEMPLATE_TYPE_MESSAGES.createForbidden
            : TEMPLATE_TYPE_MESSAGES.createFailed),
      );
    } catch {
      setError(TEMPLATE_TYPE_MESSAGES.createFailed);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button">{TEMPLATE_TYPE_MESSAGES.createTrigger}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{TEMPLATE_TYPE_MESSAGES.createTitle}</DialogTitle>
          <DialogDescription>
            A new type starts empty. Upload a layout package to create its first
            draft.
          </DialogDescription>
        </DialogHeader>

        <Field>
          <FieldLabel htmlFor="template-type-name">
            {TEMPLATE_TYPE_MESSAGES.nameLabel}
          </FieldLabel>
          <Input
            id="template-type-name"
            value={name}
            maxLength={200}
            disabled={submitting}
            aria-invalid={error !== null}
            aria-describedby="template-type-name-hint template-type-name-error"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate) void create();
            }}
          />
          <FieldDescription id="template-type-name-hint">
            {TEMPLATE_TYPE_MESSAGES.nameHint}
          </FieldDescription>
          {error ? (
            <p
              id="template-type-name-error"
              role="alert"
              className="text-body-sm text-[color:var(--color-danger-700)]"
            >
              {error}
            </p>
          ) : null}
        </Field>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canCreate}
            onClick={() => void create()}
          >
            {submitting ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
