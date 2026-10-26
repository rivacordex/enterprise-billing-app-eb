"use client";

// cm21 / cm23 (custmgmt-ui-context §10.1/§10.2, code-standards §10 Styling
// rules 1–3) — the Manage Customer Billing account panel: one row per BAN with
// its state, invoice template type label and, for an open BAN, a type select
// with Save. Greying the controls is UX only — the action re-checks both
// permissions (Inv. #16). One save runs at a time across rows.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";

import { setBillingAccountTemplateAction } from "@/actions/accounts/set-billing-account-template";
import { EDIT_DISABLED_TITLE } from "@/components/accounts/edit-access";
import { AccountsNotOnboardedCard } from "@/components/customers/accounts-not-onboarded-card";
import { AccountsUnavailableCard } from "@/components/customers/accounts-unavailable-card";
import { BanStateChip } from "@/components/customers/ban-state-chip";
import { TemplateLabel } from "@/components/customers/billing-account-card";
import {
  BIND_FAILURE_MESSAGES,
  GENERIC_FAILURE,
  NEXT_RUN_CAPTION,
} from "@/components/customers/billing-account-messages";
import { TemplateTypeSelect } from "@/components/customers/template-type-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import type {
  BindableTemplateType,
  CustomerBillingAccountRow,
  CustomerBillingAccounts,
} from "@/types/accounts";

export interface BillingAccountPanelProps {
  partyRoleId: string;
  // `null` = the Accounts read failed; the panel shows AccountsUnavailableCard
  // and the rest of the Manage Customer page stays usable.
  accounts: CustomerBillingAccounts | null;
  // listBindableTemplateTypes(): Standard first, then usable types by name.
  templateTypes: BindableTemplateType[];
  canEditAccounts: boolean;
}

function BillingAccountRow({
  ban,
  templateTypes,
  canEditAccounts,
  selection,
  pending,
  busy,
  onSelect,
  onSave,
}: {
  ban: CustomerBillingAccountRow;
  templateTypes: BindableTemplateType[];
  canEditAccounts: boolean;
  selection: string | null;
  // `pending`: this row's save is in flight (spinner). `busy`: any row's save
  // is in flight — one at a time, so a settling save can't clear the pending
  // state of another still in flight and re-enable its button.
  pending: boolean;
  busy: boolean;
  onSelect: (typeId: string | null) => void;
  onSave: () => void;
}): React.JSX.Element {
  const closed = ban.state === "closed";
  const title = canEditAccounts ? undefined : EDIT_DISABLED_TITLE;
  const enabled =
    canEditAccounts && selection !== ban.refBillTemplateFamilyId && !busy;
  return (
    <li
      aria-label={`Billing account ${ban.billingAccountId}`}
      className={cn(
        "flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-start sm:justify-between",
        closed && "opacity-60",
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
      {closed ? (
        <p className="text-caption text-[color:var(--text-muted)]">
          Billing account is closed
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <TemplateTypeSelect
            id={`template-type-${ban.billingAccountId}`}
            options={templateTypes}
            value={selection}
            onChange={onSelect}
            disabled={!canEditAccounts || busy}
            title={title}
          />
          <button
            type="button"
            disabled={!enabled}
            title={title}
            onClick={onSave}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-sm px-3 text-body-sm font-medium focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none",
              enabled
                ? "border border-[color:var(--action-secondary-border)] bg-[color:var(--action-secondary-bg)] text-[color:var(--action-secondary-text)] hover:bg-[color:var(--action-ghost-hover)]"
                : "cursor-not-allowed bg-[color:var(--action-disabled-bg)] text-[color:var(--text-disabled)]",
            )}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            Save
          </button>
        </div>
      )}
    </li>
  );
}

export function BillingAccountPanel({
  partyRoleId,
  accounts,
  templateTypes,
  canEditAccounts,
}: BillingAccountPanelProps): React.JSX.Element {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Per-BAN selection; a BAN absent from the map shows its current type.
  const [selections, setSelections] = useState<Map<string, string | null>>(
    () => new Map(),
  );
  const [, startTransition] = useTransition();

  function selectionOf(ban: CustomerBillingAccountRow): string | null {
    return selections.has(ban.billingAccountId)
      ? (selections.get(ban.billingAccountId) ?? null)
      : ban.refBillTemplateFamilyId;
  }

  function setSelection(banId: string, typeId: string | null): void {
    setSelections((prev) => new Map(prev).set(banId, typeId));
  }

  function clearSelection(banId: string): void {
    setSelections((prev) => {
      const next = new Map(prev);
      next.delete(banId);
      return next;
    });
  }

  function handleSave(ban: CustomerBillingAccountRow): void {
    if (pendingId !== null) return;
    const typeId = selectionOf(ban);
    setMessage(null);
    setPendingId(ban.billingAccountId);
    startTransition(async () => {
      try {
        const result = await setBillingAccountTemplateAction({
          partyRoleId,
          billingAccountId: ban.billingAccountId,
          typeId,
          lastModified: ban.lastModified,
        });
        if (result.ok) {
          clearSelection(ban.billingAccountId);
          router.refresh();
        } else {
          setMessage(BIND_FAILURE_MESSAGES[result.code]);
          if (result.code === "TEMPLATE_NOT_BINDABLE") {
            // Reload the BAN's current type and the usable-type list.
            clearSelection(ban.billingAccountId);
            router.refresh();
          }
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
              templateTypes={templateTypes}
              canEditAccounts={canEditAccounts}
              selection={selectionOf(ban)}
              pending={pendingId === ban.billingAccountId}
              busy={pendingId !== null}
              onSelect={(typeId) => setSelection(ban.billingAccountId, typeId)}
              onSave={() => handleSave(ban)}
            />
          ))}
        </ul>
      ) : (
        <AccountsNotOnboardedCard />
      )}

      <p className="text-caption text-[color:var(--text-muted)]">
        {NEXT_RUN_CAPTION}
      </p>
    </section>
  );
}
