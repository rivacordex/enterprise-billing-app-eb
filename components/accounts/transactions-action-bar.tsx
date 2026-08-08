"use client";

import { useState } from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";

import { AllocatePaymentPanel } from "@/components/accounts/allocate-payment-panel";
import { CaptureDepositPanel } from "@/components/accounts/capture-deposit-panel";
import { CapturePaymentPanel } from "@/components/accounts/capture-payment-panel";
import { PaymentRefundPanel } from "@/components/accounts/payment-refund-panel";
import { RaiseCreditNotePanel } from "@/components/accounts/raise-credit-note-panel";
import { RaiseDebitNotePanel } from "@/components/accounts/raise-debit-note-panel";
import { RefundDepositPanel } from "@/components/accounts/refund-deposit-panel";
import { ReverseDepositPanel } from "@/components/accounts/reverse-deposit-panel";
import { RoundingAdjustmentPanel } from "@/components/accounts/rounding-adjustment-panel";
import { WriteOffPanel } from "@/components/accounts/write-off-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AssignedItem } from "@/types/accounts";

type ActionKey =
  | "capture_payment"
  | "allocate_payment"
  | "payment_refund"
  | "raise_credit_note"
  | "raise_debit_note"
  | "capture_deposit"
  | "reverse_deposit"
  | "refund_deposit"
  | "write_off"
  | "rounding_adjustment";

export interface TransactionsActionBarProps {
  financialAccountId: string | undefined;
  billingAccountId: string | undefined;
  assignedItems: AssignedItem[];
  unappliedCashAvailable: string;
}

const FA_TITLE = "Select a Financial Account in Overview.";
const FA_BAN_TITLE = "Select a Billing Account in Overview.";

// Strips the panel's outer section chrome (border/bg/padding) and hides its
// internal <h3> heading — DialogTitle provides the accessible title instead.
// inv. #20: panel files are byte-identical; only the wrapper composition changes.
const PANEL_CLASS =
  "sm:max-w-lg [&_section]:border-0 [&_section]:bg-transparent [&_section]:p-0 [&_section>h3]:hidden";

export function TransactionsActionBar({
  financialAccountId,
  billingAccountId,
  assignedItems,
  unappliedCashAvailable,
}: TransactionsActionBarProps): React.JSX.Element {
  const [openAction, setOpenAction] = useState<ActionKey | null>(null);

  const hasFa = Boolean(financialAccountId);
  const hasFaBan = hasFa && Boolean(billingAccountId);

  function close(): void {
    setOpenAction(null);
  }

  function onOpenChange(open: boolean): void {
    if (!open) close();
  }

  // Title for a FA+BAN-required entry or trigger when FA and/or BAN are absent.
  const faBanTitle = !hasFa ? FA_TITLE : FA_BAN_TITLE;

  // + Payment: all three entries need at least FA; trigger disabled only when
  // all are disabled (i.e. no FA — even with FA-only, Capture Payment is enabled).
  const paymentTriggerDisabled = !hasFa;

  // + Note: both entries need FA + BAN; trigger disabled when both are disabled.
  const noteTriggerDisabled = !hasFaBan;

  // More actions: deposit entries need only FA; trigger disabled when all are
  // disabled (i.e. no FA — with only FA, the three deposit entries are enabled).
  const moreTriggerDisabled = !hasFa;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {/* + Payment — primary (D3) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={paymentTriggerDisabled}>
            <Button
              variant="default"
              disabled={paymentTriggerDisabled}
              title={paymentTriggerDisabled ? FA_TITLE : undefined}
            >
              <PlusIcon data-icon="inline-start" />
              Payment
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              disabled={!hasFa}
              title={!hasFa ? FA_TITLE : undefined}
              onSelect={() => setOpenAction("capture_payment")}
            >
              Capture Payment
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!hasFaBan}
              title={!hasFaBan ? faBanTitle : undefined}
              onSelect={() => setOpenAction("allocate_payment")}
            >
              Allocate Payment
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!hasFaBan}
              title={!hasFaBan ? faBanTitle : undefined}
              onSelect={() => setOpenAction("payment_refund")}
            >
              Payment Refund
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* + Note — primary (D3) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={noteTriggerDisabled}>
            <Button
              variant="default"
              disabled={noteTriggerDisabled}
              title={noteTriggerDisabled ? faBanTitle : undefined}
            >
              <PlusIcon data-icon="inline-start" />
              Note
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              disabled={!hasFaBan}
              title={!hasFaBan ? faBanTitle : undefined}
              onSelect={() => setOpenAction("raise_credit_note")}
            >
              Raise Credit Note
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!hasFaBan}
              title={!hasFaBan ? faBanTitle : undefined}
              onSelect={() => setOpenAction("raise_debit_note")}
            >
              Raise Debit Note
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* More actions — secondary (D3) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={moreTriggerDisabled}>
            <Button
              variant="outline"
              disabled={moreTriggerDisabled}
              title={moreTriggerDisabled ? FA_TITLE : undefined}
            >
              More actions
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              disabled={!hasFa}
              title={!hasFa ? FA_TITLE : undefined}
              onSelect={() => setOpenAction("capture_deposit")}
            >
              Capture Security Deposit
            </DropdownMenuItem>
            <DropdownMenuItem
              className="flex-col items-start"
              disabled={!hasFa}
              title={!hasFa ? FA_TITLE : undefined}
              onSelect={() => setOpenAction("reverse_deposit")}
            >
              <span>Reverse Deposit to Account</span>
              <span className="text-xs text-muted-foreground">
                Applies deposit to A/R — not a ledger reversal
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!hasFa}
              title={!hasFa ? FA_TITLE : undefined}
              onSelect={() => setOpenAction("refund_deposit")}
            >
              Refund Deposit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!hasFaBan}
              title={!hasFaBan ? faBanTitle : undefined}
              onSelect={() => setOpenAction("write_off")}
            >
              Write Off
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!hasFaBan}
              title={!hasFaBan ? faBanTitle : undefined}
              onSelect={() => setOpenAction("rounding_adjustment")}
            >
              Rounding Adjustment
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Dialog wrappers — one per operation (inv. #20: panels byte-identical) */}

      <Dialog
        open={openAction === "capture_payment"}
        onOpenChange={onOpenChange}
      >
        <DialogContent className={PANEL_CLASS}>
          <DialogHeader>
            <DialogTitle>Capture Payment</DialogTitle>
          </DialogHeader>
          <CapturePaymentPanel financialAccountId={financialAccountId} />
        </DialogContent>
      </Dialog>

      <Dialog
        open={openAction === "allocate_payment"}
        onOpenChange={onOpenChange}
      >
        <DialogContent className={PANEL_CLASS}>
          <DialogHeader>
            <DialogTitle>Allocate Payment</DialogTitle>
          </DialogHeader>
          <AllocatePaymentPanel
            financialAccountId={financialAccountId}
            billingAccountId={billingAccountId}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={openAction === "payment_refund"}
        onOpenChange={onOpenChange}
      >
        <DialogContent className={PANEL_CLASS}>
          <DialogHeader>
            <DialogTitle>Payment Refund</DialogTitle>
          </DialogHeader>
          <PaymentRefundPanel
            financialAccountId={financialAccountId}
            billingAccountId={billingAccountId}
            assignedItems={assignedItems}
            unappliedCashAvailable={unappliedCashAvailable}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={openAction === "raise_credit_note"}
        onOpenChange={onOpenChange}
      >
        <DialogContent className={PANEL_CLASS}>
          <DialogHeader>
            <DialogTitle>Raise Credit Note</DialogTitle>
          </DialogHeader>
          <RaiseCreditNotePanel
            financialAccountId={financialAccountId}
            billingAccountId={billingAccountId}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={openAction === "raise_debit_note"}
        onOpenChange={onOpenChange}
      >
        <DialogContent className={PANEL_CLASS}>
          <DialogHeader>
            <DialogTitle>Raise Debit Note</DialogTitle>
          </DialogHeader>
          <RaiseDebitNotePanel
            financialAccountId={financialAccountId}
            billingAccountId={billingAccountId}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={openAction === "capture_deposit"}
        onOpenChange={onOpenChange}
      >
        <DialogContent className={PANEL_CLASS}>
          <DialogHeader>
            <DialogTitle>Capture Security Deposit</DialogTitle>
          </DialogHeader>
          <CaptureDepositPanel financialAccountId={financialAccountId} />
        </DialogContent>
      </Dialog>

      <Dialog
        open={openAction === "reverse_deposit"}
        onOpenChange={onOpenChange}
      >
        <DialogContent className={PANEL_CLASS}>
          <DialogHeader>
            <DialogTitle>Reverse Deposit to Account</DialogTitle>
          </DialogHeader>
          <ReverseDepositPanel financialAccountId={financialAccountId} />
        </DialogContent>
      </Dialog>

      <Dialog
        open={openAction === "refund_deposit"}
        onOpenChange={onOpenChange}
      >
        <DialogContent className={PANEL_CLASS}>
          <DialogHeader>
            <DialogTitle>Refund Deposit</DialogTitle>
          </DialogHeader>
          <RefundDepositPanel financialAccountId={financialAccountId} />
        </DialogContent>
      </Dialog>

      <Dialog open={openAction === "write_off"} onOpenChange={onOpenChange}>
        <DialogContent className={PANEL_CLASS}>
          <DialogHeader>
            <DialogTitle>Write Off</DialogTitle>
          </DialogHeader>
          <WriteOffPanel
            financialAccountId={financialAccountId}
            billingAccountId={billingAccountId}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={openAction === "rounding_adjustment"}
        onOpenChange={onOpenChange}
      >
        <DialogContent className={PANEL_CLASS}>
          <DialogHeader>
            <DialogTitle>Rounding Adjustment</DialogTitle>
          </DialogHeader>
          <RoundingAdjustmentPanel
            financialAccountId={financialAccountId}
            billingAccountId={billingAccountId}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
