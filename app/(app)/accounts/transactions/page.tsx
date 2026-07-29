import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { meetsLevel } from "@/types/permissions";
import { AllocatePaymentPanel } from "@/components/accounts/allocate-payment-panel";
import { CaptureDepositPanel } from "@/components/accounts/capture-deposit-panel";
import { CapturePaymentPanel } from "@/components/accounts/capture-payment-panel";
import { ContextStrip } from "@/components/accounts/context-strip";
import { PaymentRefundPanel } from "@/components/accounts/payment-refund-panel";
import { PendingApprovalsList } from "@/components/accounts/pending-approvals-list";
import { RefundDepositPanel } from "@/components/accounts/refund-deposit-panel";
import { ReverseDepositPanel } from "@/components/accounts/reverse-deposit-panel";
import { getBillingAccountDetail } from "@/services/accounts/get-billing-account-detail";
import { getFinancialAccountDetail } from "@/services/accounts/get-financial-account-detail";
import {
  getRefundWorkbenchData,
  listPendingApprovals,
} from "@/services/accounts/get-transactions-context";
import { parseAccountsContext } from "@/validation/accounts/parse-accounts-context";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Transactions" };

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { userId, permissionMap } = await requirePermission(
    PERMISSIONS.ACCOUNTS_TRANSACTIONS,
    LEVELS.READ,
  );
  const canEdit = meetsLevel(
    permissionMap[PERMISSIONS.ACCOUNTS_TRANSACTIONS],
    LEVELS.EDIT,
  );

  const params = await searchParams;
  const ctx = parseAccountsContext(params);

  const [faDetail, banDetail] = await Promise.all([
    ctx.fa ? getFinancialAccountDetail(ctx.fa) : null,
    ctx.ban ? getBillingAccountDetail(ctx.ban) : null,
  ]);

  const [pendingApprovals, refundData] = await Promise.all([
    ctx.fa ? listPendingApprovals(ctx.fa) : Promise.resolve([]),
    ctx.fa && ctx.ban
      ? getRefundWorkbenchData(ctx.fa, ctx.ban)
      : Promise.resolve({ assignedItems: [], unappliedCashAvailable: "0.00" }),
  ]);

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">Transactions</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Capture payments, allocate unapplied cash, and process refunds.
        </p>
      </header>

      <ContextStrip
        party={ctx.party}
        partyName={faDetail?.relatedParty[0]?.name}
        fa={ctx.fa}
        faName={faDetail?.fa.name}
        ban={ctx.ban}
        banName={banDetail?.ban.name}
      />

      {!canEdit && (
        <p className="text-body-sm text-muted-foreground">
          You have read-only access to Transactions.
        </p>
      )}

      {canEdit && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <CapturePaymentPanel financialAccountId={ctx.fa} />
            <AllocatePaymentPanel
              financialAccountId={ctx.fa}
              billingAccountId={ctx.ban}
            />
          </div>

          <PaymentRefundPanel
            financialAccountId={ctx.fa}
            billingAccountId={ctx.ban}
            assignedItems={refundData.assignedItems}
            unappliedCashAvailable={refundData.unappliedCashAvailable}
          />

          <div className="grid gap-4 lg:grid-cols-3">
            <CaptureDepositPanel financialAccountId={ctx.fa} />
            <ReverseDepositPanel financialAccountId={ctx.fa} />
            <RefundDepositPanel financialAccountId={ctx.fa} />
          </div>

          <section className="space-y-3">
            <h2 className="text-h3 font-semibold text-foreground">
              Pending Approvals
            </h2>
            {ctx.fa ? (
              <PendingApprovalsList
                documents={pendingApprovals}
                currentUserId={userId}
              />
            ) : (
              <p className="text-body-sm text-muted-foreground">
                Select a Financial Account to view documents pending approval.
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
