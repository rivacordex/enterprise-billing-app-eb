"use client";

// bm58-spec §Design D4, ui-context §7/§10b: `ActivateVersionDialog`, the shared
// confirm step for activating an Invoice Settings version (bm61 reuses it for
// the company profile). It shows what changes, asks for the REQUIRED change
// note, and calls `onConfirm(changeNote)`; a server refusal comes back as a
// message and renders inline in Danger.
//
// Owner decision (2026-10-10, recorded in the tracker): the dialog follows
// ui-context §7, not the spec's D4 wording: the confirm button is the standard
// PRIMARY (indigo) button and stays disabled until a change note is entered.
// The Deep Petrol "Activate" accent belongs to the page-level trigger button,
// once per screen. The server still enforces the note (`CHANGE_NOTE_REQUIRED`).

import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { CHANGE_NOTE_MAX_LENGTH } from "@/validation/billing/activate-version.schema";

export type ActivateConfirmResult =
  | { ok: true }
  | { ok: false; message: string };

export interface ActivateVersionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  // What will change, e.g. the structure diff or "No change in structure".
  summary: React.ReactNode;
  // A Warning-family callout (e.g. bank details change), when relevant.
  warning?: React.ReactNode;
  // The confirm button's label, e.g. "Activate v3".
  confirmLabel: string;
  onConfirm: (changeNote: string) => Promise<ActivateConfirmResult>;
}

export function ActivateVersionDialog({
  open,
  onOpenChange,
  title,
  summary,
  warning,
  confirmLabel,
  onConfirm,
}: ActivateVersionDialogProps): React.JSX.Element {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedLength = note.trim().length;

  function handleOpenChange(next: boolean): void {
    if (submitting) return;
    if (!next) {
      setNote("");
      setError(null);
    }
    onOpenChange(next);
  }

  async function confirm(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await onConfirm(note.trim());
      if (result.ok) {
        setNote("");
        onOpenChange(false);
      } else {
        setError(result.message);
      }
    } catch {
      setError("The version could not be activated. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Activating changes every future invoice. Invoices already issued
            keep the version they were posted under.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div data-testid="activate-summary" className="text-body-sm">
            {summary}
          </div>

          {warning ? (
            <div
              role="note"
              className="rounded-sm bg-[color:var(--color-warning-50)] px-3 py-2 text-body-sm text-[color:var(--color-warning-700)]"
            >
              {warning}
            </div>
          ) : null}

          <Field>
            <FieldLabel htmlFor="activate-change-note">
              Change note (required)
            </FieldLabel>
            <Textarea
              id="activate-change-note"
              value={note}
              maxLength={CHANGE_NOTE_MAX_LENGTH}
              rows={3}
              disabled={submitting}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="text-right text-caption text-muted-foreground tabular-nums">
              {note.length} / {CHANGE_NOTE_MAX_LENGTH}
            </p>
          </Field>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

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
            disabled={trimmedLength === 0 || submitting}
            onClick={() => void confirm()}
          >
            {submitting ? "Activating…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
