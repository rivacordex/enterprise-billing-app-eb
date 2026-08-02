"use client";

import { useState } from "react";

import {
  createGlCodeAction,
  type CreateGlCodeActionResult,
} from "@/actions/accounts/create-gl-code";
import type { GlAccount } from "@/types/accounts";
import {
  GL_ACCOUNT_CLASSES,
  GL_NORMAL_BALANCES,
} from "@/validation/accounts/gl-account.schema";

function describeCreateError(result: CreateGlCodeActionResult): string {
  if (!result.ok) {
    if (result.code === "DUPLICATE_GL_CODE") return "GL code already exists.";
    if (result.code === "PARENT_NOT_FOUND")
      return "Parent GL code not found. Check the parent code and try again.";
    if (result.code === "FORBIDDEN")
      return "You do not have permission to create GL codes.";
    if (result.code === "VALIDATION_ERROR")
      return "Please fix the highlighted fields.";
  }
  return "";
}

interface GlCodeFormProps {
  activeAccounts: GlAccount[];
}

export function GlCodeForm({
  activeAccounts,
}: GlCodeFormProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateGlCodeActionResult | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    setFieldErrors({});
    try {
      const fd = new FormData(e.currentTarget);
      const input = {
        glCode: fd.get("glCode") as string,
        name: fd.get("name") as string,
        accountClass: fd.get("accountClass") as string,
        normalBalance: fd.get("normalBalance") as string,
        parentGlCode: (fd.get("parentGlCode") as string) || null,
        isPostable: fd.get("isPostable") === "true",
      };
      const res = await createGlCodeAction(input);
      setResult(res);
      if (res.ok) {
        setOpen(false);
        (e.target as HTMLFormElement).reset();
      } else if (res.code === "VALIDATION_ERROR") {
        setFieldErrors(res.fieldErrors);
      }
    } catch {
      setResult({ ok: false, code: "FORBIDDEN" });
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-8 rounded-md bg-[color:var(--action-primary-bg)] px-3 text-body-sm font-medium text-white hover:bg-[color:var(--action-primary-bg-hover)]"
      >
        + Add GL Code
      </button>
    );
  }

  return (
    <div className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4">
      <h3 className="mb-3 text-body font-semibold text-foreground">
        Add GL Code
      </h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="gc-code"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              GL Code *
            </label>
            <input
              id="gc-code"
              name="glCode"
              required
              placeholder="e.g. 1300"
              className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground placeholder:text-muted-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            />
            {fieldErrors.glCode && (
              <span className="text-[11px] text-destructive">
                {fieldErrors.glCode.join(", ")}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="gc-name"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Name *
            </label>
            <input
              id="gc-name"
              name="name"
              required
              placeholder="e.g. Trade Receivables"
              className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground placeholder:text-muted-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            />
            {fieldErrors.name && (
              <span className="text-[11px] text-destructive">
                {fieldErrors.name.join(", ")}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="gc-class"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Account Class *
            </label>
            <select
              id="gc-class"
              name="accountClass"
              required
              className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            >
              {GL_ACCOUNT_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="gc-balance"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Normal Balance *
            </label>
            <select
              id="gc-balance"
              name="normalBalance"
              required
              className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            >
              {GL_NORMAL_BALANCES.map((b) => (
                <option key={b} value={b}>
                  {b.charAt(0).toUpperCase() + b.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="gc-parent"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Parent GL Code
            </label>
            <select
              id="gc-parent"
              name="parentGlCode"
              className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            >
              <option value="">— None (top-level) —</option>
              {activeAccounts.map((a) => (
                <option key={a.glCode} value={a.glCode}>
                  {a.glCode} — {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="gc-postable"
              className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
            >
              Postable
            </label>
            <select
              id="gc-postable"
              name="isPostable"
              className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
            >
              <option value="true">Yes — accepts journal entries</option>
              <option value="false">No — summary / header only</option>
            </select>
          </div>
        </div>

        {result && !result.ok && result.code !== "VALIDATION_ERROR" && (
          <p role="alert" className="text-body-sm text-destructive">
            {describeCreateError(result)}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="h-8 rounded-md bg-[color:var(--action-primary-bg)] px-3 text-body-sm font-medium text-white hover:bg-[color:var(--action-primary-bg-hover)] disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save GL Code"}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setResult(null);
              setFieldErrors({});
            }}
            className="h-8 rounded-md border border-[color:var(--border-default)] px-3 text-body-sm text-foreground hover:bg-[color:var(--surface-sunken)]"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
