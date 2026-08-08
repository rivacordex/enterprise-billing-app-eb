"use client";

import { useState } from "react";
import { ChevronDown, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  TransactionDialogs,
  type ActionKey,
} from "@/components/accounts/transaction-dialogs";
import type { AssignedItem } from "@/types/accounts";

// ac19-spec §2.2/§3.2 — the three-control action bar (D3). `openAction` is
// transient client UI state, not selection context (inv. #17) — it never
// carries party/FA/BAN, so it's exempt from the URL-context rule that
// governs `ContextStrip`.

type Requirement = "fa" | "fa+ban";

interface ActionEntry {
  key: ActionKey;
  label: string;
  requirement: Requirement;
  description?: string;
}

const PAYMENT_ENTRIES: ActionEntry[] = [
  { key: "capturePayment", label: "Capture Payment", requirement: "fa" },
  {
    key: "allocatePayment",
    label: "Allocate Payment",
    requirement: "fa+ban",
  },
  { key: "paymentRefund", label: "Payment Refund", requirement: "fa+ban" },
];

const NOTE_ENTRIES: ActionEntry[] = [
  {
    key: "raiseCreditNote",
    label: "Raise Credit Note",
    requirement: "fa+ban",
  },
  { key: "raiseDebitNote", label: "Raise Debit Note", requirement: "fa+ban" },
];

const MORE_ENTRIES: ActionEntry[] = [
  {
    key: "captureDeposit",
    label: "Capture Security Deposit",
    requirement: "fa",
  },
  {
    key: "reverseDeposit",
    label: "Reverse Deposit to Account",
    requirement: "fa",
    description: "Applies deposit to A/R — not a ledger reversal",
  },
  { key: "refundDeposit", label: "Refund Deposit", requirement: "fa" },
  { key: "writeOff", label: "Write Off", requirement: "fa+ban" },
  {
    key: "roundingAdjustment",
    label: "Rounding Adjustment",
    requirement: "fa+ban",
  },
];

function entryState(
  requirement: Requirement,
  financialAccountId: string | undefined,
  billingAccountId: string | undefined,
): { disabled: boolean; title: string | undefined } {
  if (!financialAccountId) {
    return {
      disabled: true,
      title: "Select a Financial Account in Overview",
    };
  }
  if (requirement === "fa+ban" && !billingAccountId) {
    return { disabled: true, title: "Select a Billing Account in Overview" };
  }
  return { disabled: false, title: undefined };
}

function groupState(
  entries: ActionEntry[],
  financialAccountId: string | undefined,
  billingAccountId: string | undefined,
): { disabled: boolean; title: string | undefined } {
  const states = entries.map((entry) =>
    entryState(entry.requirement, financialAccountId, billingAccountId),
  );
  const disabled = states.every((state) => state.disabled);
  return { disabled, title: disabled ? states[0]?.title : undefined };
}

function ActionMenu({
  label,
  entries,
  variant,
  showPlus,
  financialAccountId,
  billingAccountId,
  onSelect,
}: {
  label: string;
  entries: ActionEntry[];
  variant: "default" | "secondary";
  showPlus: boolean;
  financialAccountId: string | undefined;
  billingAccountId: string | undefined;
  onSelect: (key: ActionKey) => void;
}): React.JSX.Element {
  const trigger = groupState(entries, financialAccountId, billingAccountId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={variant}
          disabled={trigger.disabled}
          title={trigger.title}
        >
          {showPlus && <Plus size={14} aria-hidden />}
          {label}
          <ChevronDown size={14} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {entries.map((entry) => {
          const state = entryState(
            entry.requirement,
            financialAccountId,
            billingAccountId,
          );
          return (
            <DropdownMenuItem
              key={entry.key}
              disabled={state.disabled}
              title={state.title}
              onSelect={() => onSelect(entry.key)}
            >
              <div className="flex flex-col gap-0.5 py-0.5">
                <span>{entry.label}</span>
                {entry.description && (
                  <span className="text-xs text-muted-foreground">
                    {entry.description}
                  </span>
                )}
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface TransactionsActionBarProps {
  financialAccountId: string | undefined;
  billingAccountId: string | undefined;
  assignedItems: AssignedItem[];
  unappliedCashAvailable: string;
}

export function TransactionsActionBar({
  financialAccountId,
  billingAccountId,
  assignedItems,
  unappliedCashAvailable,
}: TransactionsActionBarProps): React.JSX.Element {
  const [openAction, setOpenAction] = useState<ActionKey | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <ActionMenu
        label="Payment"
        entries={PAYMENT_ENTRIES}
        variant="default"
        showPlus
        financialAccountId={financialAccountId}
        billingAccountId={billingAccountId}
        onSelect={setOpenAction}
      />
      <ActionMenu
        label="Note"
        entries={NOTE_ENTRIES}
        variant="default"
        showPlus
        financialAccountId={financialAccountId}
        billingAccountId={billingAccountId}
        onSelect={setOpenAction}
      />
      <ActionMenu
        label="More actions"
        entries={MORE_ENTRIES}
        variant="secondary"
        showPlus={false}
        financialAccountId={financialAccountId}
        billingAccountId={billingAccountId}
        onSelect={setOpenAction}
      />

      <TransactionDialogs
        openAction={openAction}
        onOpenChange={(open) => {
          if (!open) setOpenAction(null);
        }}
        financialAccountId={financialAccountId}
        billingAccountId={billingAccountId}
        assignedItems={assignedItems}
        unappliedCashAvailable={unappliedCashAvailable}
      />
    </div>
  );
}
