"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { closeBillingAccountAction } from "@/actions/accounts/close-billing-account";
import { closeFinancialAccountAction } from "@/actions/accounts/close-financial-account";
import { AmountCell } from "@/components/accounts/amount-cell";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import type {
  BillingAccountClosureStatus,
  FinancialAccountClosureStatus,
} from "@/types/accounts";

export interface ClosurePanelProps {
  ban: {
    billingAccountId: string;
    state: string;
    lastModified: Date;
    currency: string;
  } | null;
  banClosure: BillingAccountClosureStatus | null;
  fa: {
    financialAccountId: string;
    state: string;
    lastModified: Date;
    currency: string;
  } | null;
  faClosure: FinancialAccountClosureStatus | null;
}

// ac16-spec §2.3/§3.5 — the guided settle-first path: no shortcut, just a
// pointer to the real operations (each with its own approval routing)
// already available elsewhere on this page, plus a live re-check of the
// zero-balance gate after every step (automatic — every other panel on this
// page calls `router.refresh()` on success, which re-fetches this panel's
// server-computed eligibility props too).
const GUIDED_STEPS = [
  "Reverse deposit — release held deposit into unapplied cash (DEP_REVERSE)",
  "Allocate — apply unapplied cash against open A/R",
  "Refund remainder — pay out any unapplied cash left (DEP_REFUND)",
  "Write off residue — clear any uncollectable A/R remainder (BAD_DEBT_WRITEOFF)",
];

function describeCloseError(code: string): string {
  switch (code) {
    case "BILLING_ACCOUNT_NOT_FOUND":
      return "Billing account not found.";
    case "FINANCIAL_ACCOUNT_NOT_FOUND":
      return "Financial account not found.";
    case "CLOSURE_BLOCKED":
      return "Balances are not yet zero — follow the guided path below.";
    case "ALREADY_CLOSED":
      return "This account is already closed.";
    case "CONFLICT":
      return "This account was modified concurrently. Please reload and try again.";
    case "FORBIDDEN":
      return "You do not have permission to perform this action.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export function ClosurePanel({
  ban,
  banClosure,
  fa,
  faClosure,
}: ClosurePanelProps): React.JSX.Element {
  const router = useRouter();
  const [submittingBan, setSubmittingBan] = useState(false);
  const [submittingFa, setSubmittingFa] = useState(false);
  const [banError, setBanError] = useState<string | null>(null);
  const [faError, setFaError] = useState<string | null>(null);
  const [banConflict, setBanConflict] = useState(false);
  const [faConflict, setFaConflict] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const disabled = !ban && !fa;

  async function handleCloseBan(): Promise<void> {
    if (!ban) return;
    setSubmittingBan(true);
    setBanError(null);
    setBanConflict(false);
    setMessage(null);
    try {
      const result = await closeBillingAccountAction({
        billingAccountId: ban.billingAccountId,
        lastModified: ban.lastModified,
      });
      if (!result.ok) {
        setBanError(describeCloseError(result.code));
        setBanConflict(result.code === "CONFLICT");
        return;
      }
      setMessage(`Billing account ${result.value.billingAccountId} closed.`);
      router.refresh();
    } catch {
      setBanError("Something went wrong. Please try again.");
    } finally {
      setSubmittingBan(false);
    }
  }

  async function handleCloseFa(): Promise<void> {
    if (!fa) return;
    setSubmittingFa(true);
    setFaError(null);
    setFaConflict(false);
    setMessage(null);
    try {
      const result = await closeFinancialAccountAction({
        financialAccountId: fa.financialAccountId,
        lastModified: fa.lastModified,
      });
      if (!result.ok) {
        setFaError(describeCloseError(result.code));
        setFaConflict(result.code === "CONFLICT");
        return;
      }
      setMessage(
        `Financial account ${result.value.financialAccountId} closed.`,
      );
      router.refresh();
    } catch {
      setFaError("Something went wrong. Please try again.");
    } finally {
      setSubmittingFa(false);
    }
  }

  return (
    <section className="space-y-4 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4">
      <h3 className="text-h4 font-semibold text-foreground">Account Closure</h3>
      {disabled && (
        <p className="text-body-sm text-muted-foreground">
          Select a Financial Account or Billing Account in the context strip to
          close it. Closure is zero-balance gated and is the account&apos;s
          final ledger event — it cannot be reopened.
        </p>
      )}

      {message && (
        <p
          role="status"
          aria-live="polite"
          className="text-body-sm text-[color:var(--color-success-700)]"
        >
          {message}
        </p>
      )}

      {ban && banClosure && ban.state !== "closed" && (
        <div className="space-y-2 rounded-md border border-[color:var(--border-muted)] p-3">
          <p className="text-body-sm font-medium text-foreground">
            Billing Account {ban.billingAccountId}
          </p>
          <div className="flex items-center justify-between">
            <span className="text-body-sm text-muted-foreground">Open A/R</span>
            <AmountCell
              amount={banClosure.openReceivable}
              currency={ban.currency}
            />
          </div>
          {!banClosure.eligible && (
            <p className="text-body-sm text-destructive">
              Blocked — the open A/R balance must reach zero before this billing
              account can close.
            </p>
          )}
          {banError && (
            <>
              <FieldError role="alert">{banError}</FieldError>
              {banConflict && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => router.refresh()}
                >
                  Reload
                </Button>
              )}
            </>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={!banClosure.eligible || submittingBan}
            onClick={() => void handleCloseBan()}
          >
            {submittingBan ? "Closing…" : "Close Billing Account"}
          </Button>
        </div>
      )}

      {fa && faClosure && fa.state !== "closed" && (
        <div className="space-y-2 rounded-md border border-[color:var(--border-muted)] p-3">
          <p className="text-body-sm font-medium text-foreground">
            Financial Account {fa.financialAccountId}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center justify-between">
              <span className="text-body-sm text-muted-foreground">
                Unapplied Cash
              </span>
              <AmountCell
                amount={faClosure.unappliedCash}
                currency={fa.currency}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-body-sm text-muted-foreground">
                Deposit Held
              </span>
              <AmountCell amount={faClosure.deposits} currency={fa.currency} />
            </div>
          </div>
          {!faClosure.eligible && (
            <p className="text-body-sm text-destructive">
              Blocked
              {faClosure.openBillingAccountIds.length > 0 &&
                ` — open billing accounts: ${faClosure.openBillingAccountIds.join(", ")}`}
              {faClosure.openBillingAccountIds.length === 0 &&
                " — unapplied cash and deposits must both reach zero."}
            </p>
          )}
          {faError && (
            <>
              <FieldError role="alert">{faError}</FieldError>
              {faConflict && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => router.refresh()}
                >
                  Reload
                </Button>
              )}
            </>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={!faClosure.eligible || submittingFa}
            onClick={() => void handleCloseFa()}
          >
            {submittingFa ? "Closing…" : "Close Financial Account"}
          </Button>
        </div>
      )}

      {((ban && banClosure && !banClosure.eligible) ||
        (fa && faClosure && !faClosure.eligible)) && (
        <div className="space-y-1 rounded-md bg-[color:var(--surface-sunken)] p-3">
          <p className="text-body-sm font-medium text-foreground">
            Guided settle-first path
          </p>
          <ol className="list-decimal space-y-0.5 pl-5 text-body-sm text-muted-foreground">
            {GUIDED_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="text-body-sm text-muted-foreground">
            Use the panels above to work through each step — eligibility
            re-checks automatically after every posted operation.
          </p>
        </div>
      )}
    </section>
  );
}
