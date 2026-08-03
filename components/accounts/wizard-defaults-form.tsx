"use client";

import { useState } from "react";

import {
  setWizardDefaultsAction,
  type SetWizardDefaultsActionResult,
} from "@/actions/accounts/set-wizard-defaults.action";
import type { BillCycle } from "@/types/accounts";

interface WizardDefaultsFormProps {
  activeCycles: Pick<BillCycle, "billCycleId" | "name">[];
  defaultBillCycleId: string | null;
  defaultCurrency: string | null;
  defaultCreditLimit: string | null;
}

function describeError(result: SetWizardDefaultsActionResult): string {
  if (!result.ok) {
    if (result.code === "CONFIG_NOT_FOUND")
      return "Config rows not found. Run db:seed-accounts to restore defaults.";
    if (result.code === "FORBIDDEN")
      return "You do not have permission to edit wizard defaults.";
    if (result.code === "VALIDATION_ERROR")
      return "Please fix the highlighted fields.";
  }
  return "";
}

export function WizardDefaultsForm({
  activeCycles,
  defaultBillCycleId,
  defaultCurrency,
  defaultCreditLimit,
}: WizardDefaultsFormProps): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SetWizardDefaultsActionResult | null>(
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
      const creditLimitRaw = (fd.get("defaultCreditLimit") as string).trim();
      const res = await setWizardDefaultsAction({
        defaultBillCycleId: fd.get("defaultBillCycleId") as string,
        defaultCreditLimit: creditLimitRaw === "" ? null : creditLimitRaw,
      });
      setResult(res);
      if (!res.ok && res.code === "VALIDATION_ERROR") {
        setFieldErrors(res.fieldErrors);
      }
    } catch {
      setResult({ ok: false, code: "FORBIDDEN" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Default bill cycle */}
        <div className="flex flex-col gap-1">
          <label
            htmlFor="wd-cycle"
            className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Default Bill Cycle *
          </label>
          <select
            id="wd-cycle"
            name="defaultBillCycleId"
            required
            defaultValue={defaultBillCycleId ?? ""}
            className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
          >
            {defaultBillCycleId === null && (
              <option value="" disabled>
                — select —
              </option>
            )}
            {activeCycles.map((c) => (
              <option key={c.billCycleId} value={c.billCycleId}>
                {c.name}
              </option>
            ))}
          </select>
          {fieldErrors.defaultBillCycleId && (
            <span className="text-[11px] text-destructive">
              {fieldErrors.defaultBillCycleId.join(", ")}
            </span>
          )}
        </div>

        {/* Default currency — read-only (Q12) */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            Default Currency
          </span>
          <div className="flex h-8 items-center rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)] px-3 font-mono text-body-sm text-muted-foreground">
            {defaultCurrency ?? "MYR"}
          </div>
          <span className="text-[11px] text-muted-foreground">
            Fixed — MYR only this phase (Q12)
          </span>
        </div>

        {/* Default credit limit */}
        <div className="flex flex-col gap-1">
          <label
            htmlFor="wd-limit"
            className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Default Credit Limit (MYR)
          </label>
          <input
            id="wd-limit"
            name="defaultCreditLimit"
            defaultValue={defaultCreditLimit ?? ""}
            placeholder="Leave blank for no pre-fill"
            className="h-8 rounded-md border border-[color:var(--border-default)] bg-background px-3 text-body-sm text-foreground placeholder:text-muted-foreground focus:ring-1 focus:ring-[color:var(--border-focus)] focus:outline-none"
          />
          <span className="text-[11px] text-muted-foreground">
            Pre-fills the onboarding wizard; blank = manual entry per customer.
          </span>
          {fieldErrors.defaultCreditLimit && (
            <span className="text-[11px] text-destructive">
              {fieldErrors.defaultCreditLimit.join(", ")}
            </span>
          )}
        </div>
      </div>

      {result && !result.ok && result.code !== "VALIDATION_ERROR" && (
        <p role="alert" className="text-body-sm text-destructive">
          {describeError(result)}
        </p>
      )}
      {result?.ok && (
        <p
          role="status"
          aria-live="polite"
          className="text-body-sm text-[color:var(--acct-balance-ok)]"
        >
          Wizard defaults saved.
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="h-8 rounded-md bg-[color:var(--action-primary-bg)] px-4 text-body-sm font-medium text-white hover:bg-[color:var(--action-primary-bg-hover)] disabled:opacity-50"
      >
        {submitting ? "Saving…" : "Save Defaults"}
      </button>
    </form>
  );
}
