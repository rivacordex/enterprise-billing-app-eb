"use client";

import { useState } from "react";

import {
  upsertReasonCodeAction,
  type UpsertReasonCodeActionResult,
} from "@/actions/accounts/upsert-reason-code.action";
import {
  retireReasonCodeAction,
  type RetireReasonCodeActionResult,
} from "@/actions/accounts/retire-reason-code.action";
import type { ReasonCode } from "@/types/accounts";
import { DOC_TYPES, POSTING_NATURES } from "@/types/accounts";

const DOC_TYPE_LABELS: Record<string, string> = {
  PAY: "PAY — Payment",
  DEP: "DEP — Deposit",
  CRN: "CRN — Credit Note",
  DBN: "DBN — Debit Note",
  ADJ: "ADJ — Adjustment",
  INV: "INV — Invoice",
};

const NATURE_LABELS: Record<string, string> = {
  revenue: "revenue — income",
  revenue_adj: "revenue_adj — credit adjustment",
  write_off: "write_off — bad debt",
  rounding: "rounding — cent rounding",
  cash: "cash — cash movement",
  deposit_movement: "deposit_movement — deposit",
};

// Pure string check — components may not import services/accounts/money.ts
// (eslint-plugin-boundaries: components → services is disallowed), so a
// zero-threshold display check can't route through money.ts. `parseFloat`/
// `Number()` on an amount is banned everywhere outside money.ts (code-
// standards §2.2, ac17 grep-gate) even for a display-only comparison, so
// this checks the well-formed `numeric(18,2)`-derived string directly
// rather than converting it to a float.
function isZeroAmount(amount: string): boolean {
  return /^-?0+(\.0+)?$/.test(amount.trim());
}

function StateChip({ state }: { state: string }): React.JSX.Element {
  const cls =
    state === "active"
      ? "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]"
      : "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-400)]";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase ${cls}`}
    >
      {state === "active" ? "Active" : "Retired"}
    </span>
  );
}

function describeUpsertError(result: UpsertReasonCodeActionResult): string {
  if (!result.ok) {
    if (result.code === "DUPLICATE_CODE")
      return "A reason code with this code already exists.";
    if (result.code === "CONFLICT")
      return "Another user modified this record. Refresh and try again.";
    if (result.code === "NOT_FOUND") return "Reason code not found.";
    if (result.code === "ALREADY_RETIRED")
      return "This reason code is already retired.";
    if (result.code === "IMMUTABLE_FIELD")
      return "Doc type and posting nature cannot be changed after creation.";
    if (result.code === "LAST_MODIFIED_REQUIRED")
      return "Optimistic lock token missing. Refresh and try again.";
    if (result.code === "FORBIDDEN")
      return "You do not have permission to manage reason codes.";
    if (result.code === "VALIDATION_ERROR")
      return "Please fix the highlighted fields.";
  }
  return "";
}

function describeRetireError(result: RetireReasonCodeActionResult): string {
  if (!result.ok) {
    if (result.code === "ALREADY_RETIRED")
      return "This reason code is already retired.";
    if (result.code === "CONFLICT")
      return "Another user modified this record. Refresh and try again.";
    if (result.code === "NOT_FOUND") return "Reason code not found.";
    if (result.code === "FORBIDDEN") return "You do not have permission.";
  }
  return "";
}

// ── Add form ──────────────────────────────────────────────────────────────────

export function AddReasonCodeButton(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<UpsertReasonCodeActionResult | null>(
    null,
  );
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string[] | undefined>
  >({});

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    setFieldErrors({});
    try {
      const fd = new FormData(e.currentTarget);
      const res = await upsertReasonCodeAction({
        reasonCode: fd.get("reasonCode") as string,
        name: (fd.get("name") as string) || undefined,
        description: (fd.get("description") as string) || undefined,
        docType: fd.get("docType") as string,
        postingNature: fd.get("postingNature") as string,
        autoPostLimit: fd.get("autoPostLimit") as string,
      });
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
        + Add Reason Code
      </button>
    );
  }

  return (
    <div className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4">
      <h3 className="mb-3 text-body font-semibold text-foreground">
        Add Reason Code
      </h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FieldWrapper label="Code *" error={fieldErrors.reasonCode}>
            <input
              name="reasonCode"
              required
              placeholder="e.g. GOODWILL_CREDIT"
              className={INPUT_CLS}
            />
          </FieldWrapper>
          <FieldWrapper label="Name" error={fieldErrors.name}>
            <input
              name="name"
              placeholder="Human-readable label"
              className={INPUT_CLS}
            />
          </FieldWrapper>
          <FieldWrapper label="Doc Type *" error={fieldErrors.docType}>
            <select name="docType" required className={INPUT_CLS}>
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOC_TYPE_LABELS[t] ?? t}
                </option>
              ))}
            </select>
          </FieldWrapper>
          <FieldWrapper
            label="Posting Nature *"
            error={fieldErrors.postingNature}
          >
            <select name="postingNature" required className={INPUT_CLS}>
              {POSTING_NATURES.map((n) => (
                <option key={n} value={n}>
                  {NATURE_LABELS[n] ?? n}
                </option>
              ))}
            </select>
          </FieldWrapper>
          <FieldWrapper
            label="Auto-Post Limit (MYR) *"
            error={fieldErrors.autoPostLimit}
          >
            <input
              name="autoPostLimit"
              required
              placeholder="0.00 = always four-eyes"
              className={INPUT_CLS}
            />
          </FieldWrapper>
          <FieldWrapper label="Description" error={fieldErrors.description}>
            <input
              name="description"
              placeholder="Optional notes"
              className={INPUT_CLS}
            />
          </FieldWrapper>
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
            {submitting ? "Saving…" : "Save"}
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

// ── Edit / Retire inline controls — renders the complete <tr> ─────────────────

interface ReasonCodeActionsProps {
  row: ReasonCode;
}

export function ReasonCodeActions({
  row,
}: ReasonCodeActionsProps): React.JSX.Element {
  const [mode, setMode] = useState<"idle" | "edit" | "retiring">("idle");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    UpsertReasonCodeActionResult | RetireReasonCodeActionResult | null
  >(null);
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string[] | undefined>
  >({});

  async function handleEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    setFieldErrors({});
    try {
      const fd = new FormData(e.currentTarget);
      const res = await upsertReasonCodeAction({
        reasonCode: row.reasonCode,
        name: (fd.get("name") as string) || undefined,
        description: (fd.get("description") as string) || undefined,
        docType: row.docType,
        postingNature: row.postingNature,
        autoPostLimit: fd.get("autoPostLimit") as string,
        lastModified: row.lastModified.toISOString(),
      });
      setResult(res);
      if (res.ok) setMode("idle");
      else if (res.code === "VALIDATION_ERROR") setFieldErrors(res.fieldErrors);
    } catch {
      setResult({ ok: false, code: "FORBIDDEN" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRetire() {
    setSubmitting(true);
    setResult(null);
    try {
      const res = await retireReasonCodeAction({
        reasonCode: row.reasonCode,
        lastModified: row.lastModified.toISOString(),
      });
      setResult(res);
      if (res.ok) setMode("idle");
    } catch {
      setResult({ ok: false, code: "FORBIDDEN" });
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === "edit") {
    return (
      <tr>
        <td colSpan={7} className="bg-[color:var(--surface-sunken)] px-4 py-3">
          <form
            onSubmit={handleEdit}
            className="flex flex-wrap items-end gap-3"
          >
            <FieldWrapper label="Name" error={fieldErrors.name}>
              <input
                name="name"
                defaultValue={row.name ?? ""}
                className={INPUT_CLS}
              />
            </FieldWrapper>
            <FieldWrapper label="Limit (MYR)" error={fieldErrors.autoPostLimit}>
              <input
                name="autoPostLimit"
                defaultValue={row.autoPostLimit}
                required
                className={INPUT_CLS}
              />
            </FieldWrapper>
            <FieldWrapper label="Description" error={fieldErrors.description}>
              <input
                name="description"
                defaultValue={row.description ?? ""}
                className={INPUT_CLS}
              />
            </FieldWrapper>
            {result && !result.ok && result.code !== "VALIDATION_ERROR" && (
              <p role="alert" className="w-full text-body-sm text-destructive">
                {describeUpsertError(result as UpsertReasonCodeActionResult)}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={submitting}
                className="h-8 rounded-md bg-[color:var(--action-primary-bg)] px-3 text-body-sm font-medium text-white hover:bg-[color:var(--action-primary-bg-hover)] disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("idle");
                  setResult(null);
                  setFieldErrors({});
                }}
                className="h-8 rounded-md border border-[color:var(--border-default)] px-3 text-body-sm text-foreground hover:bg-[color:var(--surface-sunken)]"
              >
                Cancel
              </button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  if (mode === "retiring") {
    return (
      <tr>
        <td colSpan={7} className="bg-[color:var(--surface-sunken)] px-4 py-3">
          <div className="flex items-center gap-3">
            <p className="text-body-sm text-foreground" role="alertdialog">
              Retire{" "}
              <span className="font-mono font-semibold">{row.reasonCode}</span>?
              Existing documents are unaffected; the code will no longer appear
              for new operations.
            </p>
            {result && !result.ok && (
              <p role="alert" className="text-body-sm text-destructive">
                {describeRetireError(result as RetireReasonCodeActionResult)}
              </p>
            )}
            <button
              type="button"
              onClick={handleRetire}
              disabled={submitting}
              className="h-8 rounded-md bg-destructive px-3 text-body-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "Retiring…" : "Confirm Retire"}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("idle");
                setResult(null);
              }}
              className="h-8 rounded-md border border-[color:var(--border-default)] px-3 text-body-sm text-foreground hover:bg-[color:var(--surface-sunken)]"
            >
              Cancel
            </button>
          </div>
        </td>
      </tr>
    );
  }

  // Idle mode — render the complete data row.
  return (
    <tr className="bg-[color:var(--surface-card)] hover:bg-[color:var(--surface-sunken)]">
      <td className="px-4 py-2 font-mono font-medium text-foreground">
        {row.reasonCode}
      </td>
      <td className="px-4 py-2 text-foreground">
        {row.name ?? <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-4 py-2 font-mono text-muted-foreground">
        {row.docType}
      </td>
      <td className="px-4 py-2 text-muted-foreground">{row.postingNature}</td>
      <td className="px-4 py-2 text-foreground tabular-nums">
        {isZeroAmount(row.autoPostLimit) ? (
          <span className="text-muted-foreground">0 (always four-eyes)</span>
        ) : (
          row.autoPostLimit
        )}
      </td>
      <td className="px-4 py-2">
        <StateChip state={row.state} />
      </td>
      <td className="px-4 py-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("edit")}
            className="text-body-sm text-[color:var(--action-primary-bg)] hover:underline"
          >
            Edit
          </button>
          {row.state === "active" && (
            <button
              type="button"
              onClick={() => setMode("retiring")}
              className="text-body-sm text-destructive hover:underline"
            >
              Retire
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const INPUT_CLS =
  "h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground placeholder:text-muted-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none";

function FieldWrapper({
  label,
  error,
  children,
}: {
  label: string;
  error?: string[] | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </label>
      {children}
      {error && (
        <span className="text-[11px] text-destructive">{error.join(", ")}</span>
      )}
    </div>
  );
}
