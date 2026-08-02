"use client";

import { useState } from "react";

import {
  upsertBillCycleAction,
  type UpsertBillCycleActionResult,
} from "@/actions/accounts/upsert-bill-cycle.action";
import {
  retireBillCycleAction,
  type RetireBillCycleActionResult,
} from "@/actions/accounts/retire-bill-cycle.action";
import {
  setWizardDefaultsAction,
  type SetWizardDefaultsActionResult,
} from "@/actions/accounts/set-wizard-defaults.action";
import type { BillCycle } from "@/types/accounts";
import { BILL_CYCLE_FREQUENCIES } from "@/validation/accounts/bill-cycle.schema";

const FREQ_LABELS: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Annually",
};

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

function describeUpsertError(result: UpsertBillCycleActionResult): string {
  if (!result.ok) {
    if (result.code === "DUPLICATE_NAME")
      return "A bill cycle with this name already exists.";
    if (result.code === "CONFLICT")
      return "Another user modified this record. Refresh and try again.";
    if (result.code === "NOT_FOUND") return "Bill cycle not found.";
    if (result.code === "ALREADY_RETIRED")
      return "This bill cycle is already retired.";
    if (result.code === "LAST_MODIFIED_REQUIRED")
      return "Optimistic lock token missing. Refresh and try again.";
    if (result.code === "FORBIDDEN")
      return "You do not have permission to manage bill cycles.";
    if (result.code === "VALIDATION_ERROR")
      return "Please fix the highlighted fields.";
  }
  return "";
}

function describeRetireError(result: RetireBillCycleActionResult): string {
  if (!result.ok) {
    if (result.code === "ALREADY_RETIRED")
      return "This bill cycle is already retired.";
    if (result.code === "CONFLICT")
      return "Another user modified this record. Refresh and try again.";
    if (result.code === "NOT_FOUND") return "Bill cycle not found.";
    if (result.code === "FORBIDDEN") return "You do not have permission.";
  }
  return "";
}

// ── Add form ──────────────────────────────────────────────────────────────────

export function AddBillCycleButton(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<UpsertBillCycleActionResult | null>(
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
      const res = await upsertBillCycleAction({
        name: fd.get("name") as string,
        description: (fd.get("description") as string) || undefined,
        frequency: fd.get("frequency") as string,
        cycleDay: parseInt(fd.get("cycleDay") as string, 10),
        paymentDueDays: parseInt(fd.get("paymentDueDays") as string, 10),
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
        + Add Bill Cycle
      </button>
    );
  }

  return (
    <div className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4">
      <h3 className="mb-3 text-body font-semibold text-foreground">
        Add Bill Cycle
      </h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FieldWrapper label="Name *" error={fieldErrors.name}>
            <input
              name="name"
              required
              placeholder="e.g. Monthly – Day 1"
              className={INPUT_CLS}
            />
          </FieldWrapper>
          <FieldWrapper label="Frequency *" error={fieldErrors.frequency}>
            <select name="frequency" required className={INPUT_CLS}>
              {BILL_CYCLE_FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {FREQ_LABELS[f] ?? f}
                </option>
              ))}
            </select>
          </FieldWrapper>
          <FieldWrapper label="Cycle Day (1–28) *" error={fieldErrors.cycleDay}>
            <input
              name="cycleDay"
              type="number"
              min={1}
              max={28}
              defaultValue={1}
              required
              className={INPUT_CLS}
            />
          </FieldWrapper>
          <FieldWrapper
            label="Payment Due Days *"
            error={fieldErrors.paymentDueDays}
          >
            <input
              name="paymentDueDays"
              type="number"
              min={0}
              defaultValue={30}
              required
              className={INPUT_CLS}
            />
          </FieldWrapper>
          <div className="col-span-2">
            <FieldWrapper label="Description" error={fieldErrors.description}>
              <input
                name="description"
                placeholder="Optional notes"
                className={INPUT_CLS}
              />
            </FieldWrapper>
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

// ── Row-level actions — renders the complete <tr> ─────────────────────────────

interface BillCycleActionsProps {
  row: BillCycle;
  defaultBillCycleId: string | null;
  currentCreditLimit: string | null;
}

export function BillCycleActions({
  row,
  defaultBillCycleId,
  currentCreditLimit,
}: BillCycleActionsProps): React.JSX.Element {
  const [mode, setMode] = useState<"idle" | "edit" | "retiring">("idle");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | UpsertBillCycleActionResult
    | RetireBillCycleActionResult
    | SetWizardDefaultsActionResult
    | null
  >(null);
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string[] | undefined>
  >({});

  const isDefault = row.billCycleId === defaultBillCycleId;

  async function handleEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    setFieldErrors({});
    try {
      const fd = new FormData(e.currentTarget);
      const res = await upsertBillCycleAction({
        billCycleId: row.billCycleId,
        name: fd.get("name") as string,
        description: (fd.get("description") as string) || undefined,
        frequency: fd.get("frequency") as string,
        cycleDay: parseInt(fd.get("cycleDay") as string, 10),
        paymentDueDays: parseInt(fd.get("paymentDueDays") as string, 10),
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
      const res = await retireBillCycleAction({
        billCycleId: row.billCycleId,
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

  async function handleSetDefault() {
    setSubmitting(true);
    setResult(null);
    try {
      const res = await setWizardDefaultsAction({
        defaultBillCycleId: row.billCycleId,
        defaultCreditLimit: currentCreditLimit ?? undefined,
      });
      setResult(res);
    } catch {
      setResult({ ok: false, code: "FORBIDDEN" });
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === "edit") {
    return (
      <tr>
        <td colSpan={6} className="bg-[color:var(--surface-sunken)] px-4 py-3">
          <form
            onSubmit={handleEdit}
            className="flex flex-wrap items-end gap-3"
          >
            <FieldWrapper label="Name" error={fieldErrors.name}>
              <input
                name="name"
                defaultValue={row.name}
                required
                className={INPUT_CLS}
              />
            </FieldWrapper>
            <FieldWrapper label="Frequency" error={fieldErrors.frequency}>
              <select
                name="frequency"
                defaultValue={row.frequency}
                className={INPUT_CLS}
              >
                {BILL_CYCLE_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {FREQ_LABELS[f] ?? f}
                  </option>
                ))}
              </select>
            </FieldWrapper>
            <FieldWrapper label="Cycle Day" error={fieldErrors.cycleDay}>
              <input
                name="cycleDay"
                type="number"
                min={1}
                max={28}
                defaultValue={row.cycleDay}
                required
                className={INPUT_CLS}
              />
            </FieldWrapper>
            <FieldWrapper label="Due Days" error={fieldErrors.paymentDueDays}>
              <input
                name="paymentDueDays"
                type="number"
                min={0}
                defaultValue={row.paymentDueDays}
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
                {describeUpsertError(result as UpsertBillCycleActionResult)}
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
        <td colSpan={6} className="bg-[color:var(--surface-sunken)] px-4 py-3">
          <div className="flex items-center gap-3">
            <p className="text-body-sm text-foreground" role="alertdialog">
              Retire <span className="font-semibold">{row.name}</span>? Existing
              BANs referencing this cycle are unaffected; it will no longer
              appear for new onboarding.
              {isDefault && (
                <span className="ml-1 font-medium text-destructive">
                  This is the current default — set a different default first.
                </span>
              )}
            </p>
            {result && !result.ok && (
              <p role="alert" className="text-body-sm text-destructive">
                {describeRetireError(result as RetireBillCycleActionResult)}
              </p>
            )}
            {!isDefault && (
              <button
                type="button"
                onClick={handleRetire}
                disabled={submitting}
                className="h-8 rounded-md bg-destructive px-3 text-body-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? "Retiring…" : "Confirm Retire"}
              </button>
            )}
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
      <td className="px-4 py-2 font-medium text-foreground">
        {row.name}
        {isDefault && (
          <span className="ml-2 inline-flex items-center rounded-full bg-[color:var(--color-primary-50)] px-2 py-0.5 text-[10px] font-semibold tracking-wider text-[color:var(--color-primary-700)] uppercase">
            Default
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-muted-foreground capitalize">
        {row.frequency}
      </td>
      <td className="px-4 py-2 text-foreground tabular-nums">
        Day {row.cycleDay}
      </td>
      <td className="px-4 py-2 text-foreground tabular-nums">
        {row.paymentDueDays} days
      </td>
      <td className="px-4 py-2">
        <StateChip state={row.state} />
      </td>
      <td className="px-4 py-2">
        <div className="flex flex-wrap gap-2">
          {row.state === "active" && (
            <>
              <button
                type="button"
                onClick={() => setMode("edit")}
                className="text-body-sm text-[color:var(--action-primary-bg)] hover:underline"
              >
                Edit
              </button>
              {!isDefault && (
                <button
                  type="button"
                  onClick={handleSetDefault}
                  disabled={submitting}
                  className="text-body-sm text-[color:var(--action-primary-bg)] hover:underline disabled:opacity-50"
                >
                  {submitting ? "…" : "Set Default"}
                </button>
              )}
              <button
                type="button"
                onClick={() => setMode("retiring")}
                className="text-body-sm text-destructive hover:underline"
              >
                Retire
              </button>
            </>
          )}
          {result && result.ok === false && (
            <span role="alert" className="text-[11px] text-destructive">
              {result.code === "FORBIDDEN"
                ? "No permission."
                : "Error — refresh."}
            </span>
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
