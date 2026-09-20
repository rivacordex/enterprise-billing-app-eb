"use client";

import { useRef } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

// Coarse-pointer 44px minimum hit area for touch surfaces (ui-context §7).
const TOUCH_TARGET = "[@media(pointer:coarse)]:min-h-[44px]";

export interface InlineRowEditorProps {
  formId: string;
  isSubmitting: boolean;
  saveLabel: string;
  // A general (non-field) error — FORBIDDEN or an unexpected server failure.
  // Field-level errors live inside the wrapped form (RHF), never here.
  formError: string | null;
  onCancel: () => void;
  // The reused field-group form (PriceForm / SpecificationForm).
  children: React.ReactNode;
}

// pm41 D2/D6, review #15. The one inline-editor shell shared by the
// specification and price editors — so the D2 keyboard contract and the
// Save/Cancel footer cannot drift between them. It wraps the reused field-group
// form (children), enforces the keyboard contract (`Esc` cancels/restores;
// `Cmd`/`Ctrl+Enter` saves — the rows are multi-field, so a bare `Enter` inside
// a text input never submits prematurely), and renders explicit Save/Cancel.
export function InlineRowEditor({
  formId,
  isSubmitting,
  saveLabel,
  formError,
  onCancel,
  children,
}: InlineRowEditorProps): React.JSX.Element {
  const saveRef = useRef<HTMLButtonElement | null>(null);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter") {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        saveRef.current?.click();
      } else if (
        (event.target as HTMLElement).tagName === "INPUT" &&
        !isSubmitting
      ) {
        // Multi-field row: a bare Enter must not submit prematurely (D2).
        event.preventDefault();
      }
    }
  }

  return (
    <div onKeyDown={handleKeyDown}>
      {children}

      {formError ? (
        <p className="mt-2 text-body-sm text-[color:var(--text-danger)]">
          {formError}
        </p>
      ) : null}

      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={TOUCH_TARGET}
          disabled={isSubmitting}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          ref={saveRef}
          type="submit"
          form={formId}
          variant="outline"
          size="sm"
          className={TOUCH_TARGET}
          disabled={isSubmitting}
        >
          {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : null}
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
