"use client";

import { useState } from "react";

import {
  upsertGlMappingAction,
  type UpsertGlMappingActionResult,
} from "@/actions/accounts/upsert-gl-mapping";
import type { GlAccount, GlMapping } from "@/types/accounts";
import { GL_SELECTOR_TYPES } from "@/validation/accounts/gl-mapping.schema";

function describeUpsertError(result: UpsertGlMappingActionResult): string {
  if (!result.ok) {
    if (result.code === "ORPHAN_BLOCK")
      return `This change would leave the following ledger accounts unmapped: ${result.affectedAccounts.join(", ")}. Adjust another mapping to cover them first.`;
    if (result.code === "NON_POSTABLE_TARGET")
      return "The target GL code is a summary account (not postable). Choose a postable leaf code.";
    if (result.code === "GL_CODE_NOT_FOUND") return "Target GL code not found.";
    if (result.code === "DUPLICATE_SELECTOR")
      return "A mapping with the same selector type, selector, and currency already exists.";
    if (result.code === "CONFLICT")
      return "This mapping was edited by someone else. Reload the page and try again.";
    if (result.code === "NOT_FOUND") return "Mapping not found.";
    if (result.code === "FORBIDDEN")
      return "You do not have permission to edit mappings.";
    if (result.code === "VALIDATION_ERROR")
      return "Please fix the highlighted fields.";
  }
  return "";
}

interface GlMappingFormProps {
  postableAccounts: GlAccount[];
  editTarget?: GlMapping;
  onClose?: () => void;
}

export function GlMappingForm({
  postableAccounts,
  editTarget,
  onClose,
}: GlMappingFormProps): React.JSX.Element {
  const isEdit = !!editTarget;
  const [open, setOpen] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<UpsertGlMappingActionResult | null>(
    null,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    setFieldErrors({});
    try {
      const fd = new FormData(e.currentTarget);
      const currency = (fd.get("currency") as string) || null;
      const input = {
        glMappingId: editTarget?.glMappingId ?? null,
        selectorType: fd.get("selectorType") as string,
        selector: fd.get("selector") as string,
        currency,
        refGlCode: fd.get("refGlCode") as string,
        lastModified: editTarget?.lastModified.toISOString() ?? null,
      };
      const res = await upsertGlMappingAction(input);
      setResult(res);
      if (res.ok) {
        if (isEdit) {
          onClose?.();
        } else {
          setOpen(false);
          (e.target as HTMLFormElement).reset();
        }
      } else if (res.code === "VALIDATION_ERROR") {
        setFieldErrors(res.fieldErrors);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    setOpen(false);
    setResult(null);
    setFieldErrors({});
    onClose?.();
  }

  if (!open && !isEdit) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-8 rounded-md bg-[color:var(--action-primary-bg)] px-3 text-body-sm font-medium text-white hover:bg-[color:var(--action-primary-bg-hover)]"
      >
        + Add Mapping Rule
      </button>
    );
  }

  return (
    <div className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4">
      <h3 className="mb-3 text-body font-semibold text-foreground">
        {isEdit ? "Edit Mapping Rule" : "Add Mapping Rule"}
      </h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="gm-type"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Selector Type *
            </label>
            <select
              id="gm-type"
              name="selectorType"
              required
              defaultValue={editTarget?.selectorType ?? "ledger_role"}
              className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            >
              {GL_SELECTOR_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === "ledger_role" ? "Ledger Role" : "System Account"}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="gm-selector"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Selector *
            </label>
            <input
              id="gm-selector"
              name="selector"
              required
              defaultValue={editTarget?.selector ?? ""}
              placeholder="e.g. receivables or sys.cash.MYR"
              className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground placeholder:text-muted-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            />
            {fieldErrors.selector && (
              <span className="text-[11px] text-destructive">
                {fieldErrors.selector.join(", ")}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="gm-currency"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Currency
            </label>
            <input
              id="gm-currency"
              name="currency"
              defaultValue={editTarget?.currency ?? ""}
              placeholder="e.g. MYR (blank = all currencies)"
              maxLength={3}
              className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground placeholder:text-muted-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="gm-gl-code"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Target GL Code *
            </label>
            <select
              id="gm-gl-code"
              name="refGlCode"
              required
              defaultValue={editTarget?.refGlCode ?? ""}
              className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            >
              <option value="">— Select a postable code —</option>
              {postableAccounts.map((a) => (
                <option key={a.glCode} value={a.glCode}>
                  {a.glCode} — {a.name}
                </option>
              ))}
            </select>
            {fieldErrors.refGlCode && (
              <span className="text-[11px] text-destructive">
                {fieldErrors.refGlCode.join(", ")}
              </span>
            )}
          </div>
        </div>

        {result && !result.ok && result.code !== "VALIDATION_ERROR" && (
          <p role="alert" className="text-body-sm text-destructive">
            {describeUpsertError(result)}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="h-8 rounded-md bg-[color:var(--action-primary-bg)] px-3 text-body-sm font-medium text-white hover:bg-[color:var(--action-primary-bg-hover)] disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save Mapping"}
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="h-8 rounded-md border border-[color:var(--border-default)] px-3 text-body-sm text-foreground hover:bg-[color:var(--surface-sunken)]"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
