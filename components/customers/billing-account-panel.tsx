"use client";

// cm21 (custmgmt-ui-context §9.4/§9.5, binding plan D12) — the Manage
// Customer Billing account panel: one row per BAN with its state, invoice
// template label and a "Reset to follow active template" control. In v1 every
// BAN already follows the active template, so the reset is always disabled;
// the action and its audit are live for Phase 3. Greying the button is UX
// only — the action re-checks both permissions (Inv. #16).

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";

import { setBillingAccountTemplateAction } from "@/actions/accounts/set-billing-account-template";
import type { SetBillingAccountTemplateActionResult } from "@/actions/accounts/set-billing-account-template";
import { EDIT_DISABLED_TITLE } from "@/components/accounts/edit-access";
import { AccountsNotOnboardedCard } from "@/components/customers/accounts-not-onboarded-card";
import { AccountsUnavailableCard } from "@/components/customers/accounts-unavailable-card";
import { BanStateChip } from "@/components/customers/ban-state-chip";
import { TemplateLabel } from "@/components/customers/billing-account-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import type {
  CustomerBillingAccountRow,
  CustomerBillingAccounts,
} from "@/types/accounts";

export interface BillingAccountPanelProps {
  partyRoleId: string;
  // `null` = the Accounts read failed; the panel shows AccountsUnavailableCard
  // and the rest of the Manage Customer page stays usable.
  accounts: CustomerBillingAccounts | null;
  canEditAccounts: boolean;
}

const GENERIC_FAILURE = "Something went wrong. Please try again.";

type FailureCode = Extract<
  SetBillingAccountTemplateActionResult,
  { ok: false }
>["code"];

export const RESET_FAILURE_MESSAGES: Record<FailureCode, string> = {
  CONFLICT:
    "This billing account was changed by someone else. Reload and try again.",
  BAN_CLOSED: "This billing account is closed.",
  TEMPLATE_NOT_BINDABLE: "This invoice template cannot be assigned.",
  BAN_NOT_FOUND: "Billing account not found. Reload the page.",
  FORBIDDEN: "You do not have permission to change billing accounts.",
  // Not spec-defined (bad ids from a tampered request); the module's generic
  // failure copy, same as the contact panel.
  VALIDATION_ERROR: GENERIC_FAILURE,
};

// §2 table: closed beats "already following"; the permission tooltip is
// layered on top of either.
function disabledCaption(ban: CustomerBillingAccountRow): string | null {
  if (ban.state === "closed") return "Billing account is closed";
  if (ban.refBillTemplateVersionId === null) {
    return "Already following the active template";
  }
  return null;
}

function BillingAccountRow({
  ban,
  canEditAccounts,
  pending,
  busy,
  onReset,
}: {
  ban: CustomerBillingAccountRow;
  canEditAccounts: boolean;
  // `pending`: this row's reset is in flight (spinner). `busy`: any row's
  // reset is in flight — one at a time, so a settling reset can't clear the
  // pending state of another still in flight and re-enable its button.
  pending: boolean;
  busy: boolean;
  onReset: (ban: CustomerBillingAccountRow) => void;
}): React.JSX.Element {
  const caption = disabledCaption(ban);
  const enabled = canEditAccounts && caption === null && !busy;
  return (
    <li
      aria-label={`Billing account ${ban.billingAccountId}`}
      className={cn(
        "flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-start sm:justify-between",
        ban.state === "closed" && "opacity-60",
      )}
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-mono text-foreground">
            {ban.billingAccountId}
          </span>
          <span className="text-body text-muted-foreground">· {ban.name}</span>
          <BanStateChip state={ban.state} />
        </div>
        <TemplateLabel label={ban.templateLabel} />
      </div>
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <button
          type="button"
          disabled={!enabled}
          title={canEditAccounts ? undefined : EDIT_DISABLED_TITLE}
          onClick={() => onReset(ban)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-body-sm font-medium focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none",
            enabled
              ? "border border-[color:var(--action-secondary-border)] bg-[color:var(--action-secondary-bg)] text-[color:var(--action-secondary-text)] hover:bg-[color:var(--action-ghost-hover)]"
              : "cursor-not-allowed bg-[color:var(--action-disabled-bg)] text-[color:var(--text-disabled)]",
          )}
        >
          {pending && <Loader2 size={14} className="animate-spin" />}
          Reset to follow active template
        </button>
        {caption !== null && (
          <p className="text-caption text-[color:var(--text-muted)]">
            {caption}
          </p>
        )}
      </div>
    </li>
  );
}

export function BillingAccountPanel({
  partyRoleId,
  accounts,
  canEditAccounts,
}: BillingAccountPanelProps): React.JSX.Element {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleReset(ban: CustomerBillingAccountRow): void {
    if (pendingId !== null) return;
    setMessage(null);
    setPendingId(ban.billingAccountId);
    startTransition(async () => {
      try {
        const result = await setBillingAccountTemplateAction({
          partyRoleId,
          billingAccountId: ban.billingAccountId,
          billTemplateVersionId: null,
          lastModified: ban.lastModified,
        });
        if (result.ok) {
          router.refresh();
        } else {
          setMessage(RESET_FAILURE_MESSAGES[result.code]);
        }
      } catch {
        setMessage(GENERIC_FAILURE);
      } finally {
        setPendingId(null);
      }
    });
  }

  return (
    <section
      aria-label="Billing account"
      className="space-y-4 rounded-md border border-border bg-[color:var(--surface-card)] p-4"
    >
      <h2 className="text-h3 font-semibold text-foreground">Billing account</h2>

      {message !== null && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      {accounts === null ? (
        <AccountsUnavailableCard />
      ) : accounts.onboarded ? (
        <ul className="flex flex-col gap-3">
          {accounts.bans.map((ban) => (
            <BillingAccountRow
              key={ban.billingAccountId}
              ban={ban}
              canEditAccounts={canEditAccounts}
              pending={pendingId === ban.billingAccountId}
              busy={pendingId !== null}
              onReset={handleReset}
            />
          ))}
        </ul>
      ) : (
        <AccountsNotOnboardedCard />
      )}
    </section>
  );
}
