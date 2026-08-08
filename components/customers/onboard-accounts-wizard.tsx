"use client";

import { useEffect, useState } from "react";

import { getWizardOptionsAction } from "@/actions/accounts/get-wizard-options";
import type { WizardOptions } from "@/services/accounts/get-wizard-options";
import { onboardCustomerAccountsAction } from "@/actions/accounts/onboard-customer-accounts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface OnboardAccountsWizardSuccessValue {
  lastModifiedDatetime: Date;
  financialAccountId: string;
  billingAccountId: string;
  ledgerAccountNames: [string, string, string];
}

export interface OnboardAccountsWizardProps {
  open: boolean;
  partyRoleId: string;
  statusReason: string;
  lastModifiedDatetime: Date;
  onSuccess: (value: OnboardAccountsWizardSuccessValue) => void;
  onCancel: () => void;
}

type WizardPhase = "loading" | "editing" | "submitting" | "success";

interface FormState {
  billCycleId: string;
  faCreditLimit: string;
  banCreditLimit: string;
  paymentDueDaysOverride: string;
  returningCustomerAcknowledged: boolean;
}

function LoadingScreen(): React.JSX.Element {
  return (
    <div className="flex min-h-[120px] items-center justify-center">
      <p className="text-body-sm text-muted-foreground">
        Loading wizard options…
      </p>
    </div>
  );
}

function SuccessScreen({
  ledgerAccountNames,
  onDone,
}: {
  ledgerAccountNames: [string, string, string];
  onDone: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      <p className="text-body-sm text-muted-foreground">
        Accounts created and customer validated. Ledger accounts provisioned:
      </p>
      <ul className="space-y-1">
        {ledgerAccountNames.map((name) => (
          <li key={name}>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              {name}
            </code>
          </li>
        ))}
      </ul>
      <Button type="button" onClick={onDone} className="w-full">
        Done
      </Button>
    </div>
  );
}

export function OnboardAccountsWizard({
  open,
  partyRoleId,
  statusReason,
  lastModifiedDatetime,
  onSuccess,
  onCancel,
}: OnboardAccountsWizardProps): React.JSX.Element {
  const [phase, setPhase] = useState<WizardPhase>("loading");
  const [options, setOptions] = useState<WizardOptions | null>(null);
  const [form, setForm] = useState<FormState>({
    billCycleId: "",
    faCreditLimit: "",
    banCreditLimit: "",
    paymentDueDaysOverride: "",
    returningCustomerAcknowledged: false,
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successValue, setSuccessValue] =
    useState<OnboardAccountsWizardSuccessValue | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void getWizardOptionsAction(partyRoleId).then((data) => {
      if (cancelled) return;
      if (!data) {
        setSubmitError(
          "Unable to load wizard options. Please close and retry.",
        );
        setPhase("editing");
        return;
      }
      setOptions(data);
      setForm({
        billCycleId:
          data.defaults.defaultBillCycleId ??
          data.activeCycles[0]?.billCycleId ??
          "",
        faCreditLimit: data.defaults.defaultCreditLimit ?? "",
        banCreditLimit: data.defaults.defaultCreditLimit ?? "",
        paymentDueDaysOverride: "",
        returningCustomerAcknowledged: false,
      });
      setPhase("editing");
    });

    return () => {
      cancelled = true;
    };
  }, [open, partyRoleId]);

  async function handleSubmit(): Promise<void> {
    setPhase("submitting");
    setSubmitError(null);

    const result = await onboardCustomerAccountsAction({
      partyRoleId,
      billCycleId: form.billCycleId,
      currency: "MYR",
      faCreditLimit:
        form.faCreditLimit.trim() !== ""
          ? form.faCreditLimit.trim()
          : undefined,
      banCreditLimit:
        form.banCreditLimit.trim() !== ""
          ? form.banCreditLimit.trim()
          : undefined,
      paymentDueDaysOverride:
        form.paymentDueDaysOverride.trim() !== ""
          ? parseInt(form.paymentDueDaysOverride.trim(), 10)
          : undefined,
      statusReason,
      lastModifiedDatetime,
    });

    if (result.ok) {
      const sv: OnboardAccountsWizardSuccessValue = {
        lastModifiedDatetime: result.value.lastModifiedDatetime,
        financialAccountId: result.value.financialAccountId,
        billingAccountId: result.value.billingAccountId,
        ledgerAccountNames: result.value.ledgerAccountNames,
      };
      setSuccessValue(sv);
      setPhase("success");
      onSuccess(sv);
      return;
    }

    setPhase("editing");
    switch (result.code) {
      case "CONFLICT":
        setSubmitError(
          "This customer was modified by someone else. Please close, reload, and try again.",
        );
        break;
      case "CYCLE_RETIRED":
        setSubmitError(
          "The selected bill cycle has been retired. Please choose an active cycle.",
        );
        break;
      case "INVALID_TRANSITION":
        setSubmitError(
          "This customer is not in INITIALIZED status. The wizard cannot be used here.",
        );
        break;
      case "FORBIDDEN":
        setSubmitError("You do not have permission to perform this action.");
        break;
      case "PARTY_ROLE_NOT_FOUND":
        setSubmitError(
          "Customer record not found. Please reload the page and try again.",
        );
        break;
      case "VALIDATION_ERROR": {
        const fieldMsgs = Object.entries(result.fieldErrors ?? {}).flatMap(
          ([field, errs]) => errs.map((e) => `${field}: ${e}`),
        );
        setSubmitError(
          fieldMsgs.length > 0
            ? `Validation failed — ${fieldMsgs.join("; ")}.`
            : "Validation failed. Please check the form and try again.",
        );
        break;
      }
      default:
        setSubmitError("Something went wrong. Please try again.");
    }
  }

  const hasReturningCustomers = (options?.priorAccounts.length ?? 0) > 0;

  const canSubmit =
    phase === "editing" &&
    form.billCycleId !== "" &&
    (!hasReturningCustomers || form.returningCustomerAcknowledged);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && phase !== "submitting") onCancel();
      }}
    >
      <DialogContent
        showCloseButton={phase !== "submitting"}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Set Up Customer Accounts</DialogTitle>
          <DialogDescription>
            Creating accounts will validate this customer. Fill in the details
            below, then confirm.
          </DialogDescription>
        </DialogHeader>

        {phase === "loading" && <LoadingScreen />}

        {phase === "success" && successValue && (
          <SuccessScreen
            ledgerAccountNames={successValue.ledgerAccountNames}
            onDone={onCancel}
          />
        )}

        {(phase === "editing" || phase === "submitting") && options && (
          <div className="space-y-4">
            {/* Returning-customer gate */}
            {hasReturningCustomers && (
              <div className="border-warning bg-warning/10 rounded-md border p-3 text-body-sm">
                <p className="mb-2 font-semibold text-foreground">
                  Prior accounts exist for this organisation
                </p>
                <ul className="mb-3 space-y-1 text-muted-foreground">
                  {options.priorAccounts.map((a) => (
                    <li
                      key={a.financialAccountId}
                      className="font-mono text-xs"
                    >
                      {a.financialAccountId} — {a.name} ({a.state})
                    </li>
                  ))}
                </ul>
                <label className="flex cursor-pointer items-center gap-2 text-foreground">
                  <input
                    type="checkbox"
                    checked={form.returningCustomerAcknowledged}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        returningCustomerAcknowledged: e.target.checked,
                      }))
                    }
                    disabled={phase === "submitting"}
                  />
                  I understand — create new accounts for this customer
                </label>
              </div>
            )}

            {/* Currency — read-only (Q12) */}
            <Field>
              <FieldLabel>Currency</FieldLabel>
              <Input
                value="MYR"
                readOnly
                className="bg-muted/50 text-muted-foreground"
              />
            </Field>

            {/* Bill Cycle */}
            <Field>
              <FieldLabel>Bill Cycle</FieldLabel>
              <Select
                value={form.billCycleId}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, billCycleId: v }))
                }
                disabled={phase === "submitting"}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a bill cycle…" />
                </SelectTrigger>
                <SelectContent>
                  {options.activeCycles.map((c) => (
                    <SelectItem key={c.billCycleId} value={c.billCycleId}>
                      {c.name} ({c.paymentDueDays}d terms)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {/* FA Credit Limit */}
            <Field>
              <FieldLabel>FA Credit Limit (optional)</FieldLabel>
              <Input
                type="text"
                inputMode="decimal"
                placeholder="e.g. 10000.00"
                value={form.faCreditLimit}
                onChange={(e) =>
                  setForm((f) => ({ ...f, faCreditLimit: e.target.value }))
                }
                disabled={phase === "submitting"}
              />
            </Field>

            {/* BAN Credit Limit */}
            <Field>
              <FieldLabel>BAN Credit Limit (optional)</FieldLabel>
              <Input
                type="text"
                inputMode="decimal"
                placeholder="e.g. 10000.00"
                value={form.banCreditLimit}
                onChange={(e) =>
                  setForm((f) => ({ ...f, banCreditLimit: e.target.value }))
                }
                disabled={phase === "submitting"}
              />
            </Field>

            {/* Payment Terms Override */}
            <Field>
              <FieldLabel>Payment Terms Override (days, optional)</FieldLabel>
              <Input
                type="number"
                min={1}
                placeholder={`Default from cycle`}
                value={form.paymentDueDaysOverride}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    paymentDueDaysOverride: e.target.value,
                  }))
                }
                disabled={phase === "submitting"}
              />
            </Field>

            {submitError && <FieldError>{submitError}</FieldError>}
          </div>
        )}

        {(phase === "editing" || phase === "submitting") && (
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={phase === "submitting"}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
              className="bg-[color:var(--action-cta-bg)] text-white hover:bg-[color:var(--action-cta-bg)]/90"
            >
              {phase === "submitting"
                ? "Setting up accounts…"
                : "Set Up Accounts"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
