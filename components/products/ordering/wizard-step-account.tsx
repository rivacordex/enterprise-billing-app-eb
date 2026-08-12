"use client";

import type { WizardBillingAccountOption } from "@/actions/accounts/new-order-wizard-reads";

export interface WizardStepAccountProps {
  isLoading: boolean;
  financialAccountName: string | null;
  bans: WizardBillingAccountOption[];
  selectedAccount: WizardBillingAccountOption | null;
  onSelect: (account: WizardBillingAccountOption) => void;
}

// pm29-spec §Implementation-2 (`WizardStepAccount`). Presentational only —
// the BAN list is fetched once by `NewOrderWizard` (per selected customer)
// and passed down, so navigating back to this step never re-fetches
// (Design — "Back/forward between steps never refetches committed data").
// Non-closed BANs of the selected customer's FA, all read-only (state pill,
// currency, cycle, resolved terms); a sole BAN is auto-preselected by the
// parent (pm29-spec §Verification checklist).
export function WizardStepAccount({
  isLoading,
  financialAccountName,
  bans,
  selectedAccount,
  onSelect,
}: WizardStepAccountProps): React.JSX.Element {
  if (isLoading) {
    return (
      <p className="text-body-sm text-muted-foreground">
        Loading billing accounts…
      </p>
    );
  }

  if (bans.length === 0) {
    return (
      <p className="text-body-sm text-muted-foreground">
        No open billing accounts found for this customer.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {financialAccountName && (
        <p className="text-body-sm text-muted-foreground">
          Financial account: {financialAccountName}
        </p>
      )}
      <ul className="divide-y divide-border rounded-md border border-border">
        {bans.map((ban) => {
          const isSelected =
            selectedAccount?.billingAccountId === ban.billingAccountId;
          return (
            <li key={ban.billingAccountId}>
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(ban)}
                className={
                  "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-body-sm hover:bg-[color:var(--action-ghost-hover)]" +
                  (isSelected ? " bg-[color:var(--surface-selected)]" : "")
                }
              >
                <span>
                  {ban.name}{" "}
                  <span className="font-mono text-mono text-muted-foreground">
                    {ban.billingAccountId}
                  </span>
                </span>
                <span className="flex items-center gap-3 text-caption text-muted-foreground">
                  <span className="rounded-full bg-[color:var(--surface-sunken)] px-2 py-0.5 uppercase">
                    {ban.state}
                  </span>
                  <span>{ban.currency}</span>
                  <span>
                    {ban.billCycleId} · {ban.billCycleName}
                  </span>
                  <span>{ban.paymentTermsDays}d terms</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
