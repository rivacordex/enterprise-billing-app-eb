"use client";

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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AssignedItem } from "@/types/accounts";

// ac19-spec §2.4/§3.3 — the dialog shells. Each panel keeps its own file,
// props, Zod schema, server action call and error mapping byte-identical
// (inv. #20); the wrapper supplies chrome only. The panel's own `<h3>` is
// visually dropped in favour of `DialogTitle` (the one permitted markup
// change) via a CSS selector scoped to the wrapper — the panel file itself
// is never touched.
export type ActionKey =
  | "capturePayment"
  | "allocatePayment"
  | "paymentRefund"
  | "raiseCreditNote"
  | "raiseDebitNote"
  | "captureDeposit"
  | "reverseDeposit"
  | "refundDeposit"
  | "writeOff"
  | "roundingAdjustment";

export interface TransactionDialogsProps {
  openAction: ActionKey | null;
  onOpenChange: (open: boolean) => void;
  financialAccountId: string | undefined;
  billingAccountId: string | undefined;
  assignedItems: AssignedItem[];
  unappliedCashAvailable: string;
}

function ActionDialog({
  actionKey,
  openAction,
  onOpenChange,
  title,
  children,
}: {
  actionKey: ActionKey;
  openAction: ActionKey | null;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Dialog open={openAction === actionKey} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="[&_h3]:hidden">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function TransactionDialogs({
  openAction,
  onOpenChange,
  financialAccountId,
  billingAccountId,
  assignedItems,
  unappliedCashAvailable,
}: TransactionDialogsProps): React.JSX.Element {
  return (
    <>
      <ActionDialog
        actionKey="capturePayment"
        openAction={openAction}
        onOpenChange={onOpenChange}
        title="Capture Payment"
      >
        <CapturePaymentPanel financialAccountId={financialAccountId} />
      </ActionDialog>

      <ActionDialog
        actionKey="allocatePayment"
        openAction={openAction}
        onOpenChange={onOpenChange}
        title="Allocate Payment"
      >
        <AllocatePaymentPanel
          financialAccountId={financialAccountId}
          billingAccountId={billingAccountId}
        />
      </ActionDialog>

      <ActionDialog
        actionKey="paymentRefund"
        openAction={openAction}
        onOpenChange={onOpenChange}
        title="Payment Refund"
      >
        <PaymentRefundPanel
          financialAccountId={financialAccountId}
          billingAccountId={billingAccountId}
          assignedItems={assignedItems}
          unappliedCashAvailable={unappliedCashAvailable}
        />
      </ActionDialog>

      <ActionDialog
        actionKey="raiseCreditNote"
        openAction={openAction}
        onOpenChange={onOpenChange}
        title="Raise Credit Note"
      >
        <RaiseCreditNotePanel
          financialAccountId={financialAccountId}
          billingAccountId={billingAccountId}
        />
      </ActionDialog>

      <ActionDialog
        actionKey="raiseDebitNote"
        openAction={openAction}
        onOpenChange={onOpenChange}
        title="Raise Debit Note"
      >
        <RaiseDebitNotePanel
          financialAccountId={financialAccountId}
          billingAccountId={billingAccountId}
        />
      </ActionDialog>

      <ActionDialog
        actionKey="captureDeposit"
        openAction={openAction}
        onOpenChange={onOpenChange}
        title="Capture Security Deposit"
      >
        <CaptureDepositPanel financialAccountId={financialAccountId} />
      </ActionDialog>

      <ActionDialog
        actionKey="reverseDeposit"
        openAction={openAction}
        onOpenChange={onOpenChange}
        title="Reverse Deposit to Account"
      >
        <ReverseDepositPanel financialAccountId={financialAccountId} />
      </ActionDialog>

      <ActionDialog
        actionKey="refundDeposit"
        openAction={openAction}
        onOpenChange={onOpenChange}
        title="Refund Deposit"
      >
        <RefundDepositPanel financialAccountId={financialAccountId} />
      </ActionDialog>

      <ActionDialog
        actionKey="writeOff"
        openAction={openAction}
        onOpenChange={onOpenChange}
        title="Write Off"
      >
        <WriteOffPanel
          financialAccountId={financialAccountId}
          billingAccountId={billingAccountId}
        />
      </ActionDialog>

      <ActionDialog
        actionKey="roundingAdjustment"
        openAction={openAction}
        onOpenChange={onOpenChange}
        title="Rounding Adjustment"
      >
        <RoundingAdjustmentPanel
          financialAccountId={financialAccountId}
          billingAccountId={billingAccountId}
        />
      </ActionDialog>
    </>
  );
}
