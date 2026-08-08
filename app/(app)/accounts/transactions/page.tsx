import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { meetsLevel } from "@/types/permissions";
import { ClosurePanel } from "@/components/accounts/closure-panel";
import { ContextStrip } from "@/components/accounts/context-strip";
import { PendingApprovalsList } from "@/components/accounts/pending-approvals-list";
import { ReversalsPanel } from "@/components/accounts/reversals-panel";
import { TransactionsActionBar } from "@/components/accounts/transactions-action-bar";
import {
  getBillingAccountClosureEligibility,
  getFinancialAccountClosureEligibility,
} from "@/services/accounts/closure-eligibility";
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

  const [pendingApprovals, refundData, banEligibility, faEligibility] =
    await Promise.all([
      canEdit && ctx.fa ? listPendingApprovals(ctx.fa) : Promise.resolve([]),
      canEdit && ctx.fa && ctx.ban
        ? getRefundWorkbenchData(ctx.fa, ctx.ban)
        : Promise.resolve({
            assignedItems: [],
            unappliedCashAvailable: "0.00",
          }),
      canEdit && ctx.ban
        ? getBillingAccountClosureEligibility(ctx.ban).catch(() => null)
        : Promise.resolve(null),
      canEdit && ctx.fa
        ? getFinancialAccountClosureEligibility(ctx.fa).catch(() => null)
        : Promise.resolve(null),
    ]);

  const banClosure =
    banEligibility && banEligibility.ok && banEligibility.eligible
      ? { eligible: true as const, openReceivable: "0.00" }
      : banEligibility && banEligibility.ok && !banEligibility.eligible
        ? {
            eligible: false as const,
            openReceivable: banEligibility.openReceivable,
          }
        : null;

  const faClosure =
    faEligibility && faEligibility.ok && faEligibility.eligible
      ? {
          eligible: true as const,
          unappliedCash: "0.00",
          deposits: "0.00",
          openBillingAccountIds: [] as string[],
        }
      : faEligibility && faEligibility.ok && !faEligibility.eligible
        ? {
            eligible: false as const,
            unappliedCash: faEligibility.unappliedCash,
            deposits: faEligibility.deposits,
            openBillingAccountIds: faEligibility.openBillingAccountIds,
          }
        : null;

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
          <TransactionsActionBar
            financialAccountId={ctx.fa}
            billingAccountId={ctx.ban}
            assignedItems={refundData.assignedItems}
            unappliedCashAvailable={refundData.unappliedCashAvailable}
          />

          <ReversalsPanel financialAccountId={ctx.fa} />

          <ClosurePanel
            ban={
              banDetail
                ? {
                    billingAccountId: banDetail.ban.billingAccountId,
                    state: banDetail.ban.state,
                    lastModified: banDetail.ban.lastModified,
                    currency: banDetail.ban.currency,
                  }
                : null
            }
            banClosure={banClosure}
            fa={
              faDetail
                ? {
                    financialAccountId: faDetail.fa.financialAccountId,
                    state: faDetail.fa.state,
                    lastModified: faDetail.fa.lastModified,
                    currency: faDetail.fa.currency,
                  }
                : null
            }
            faClosure={faClosure}
          />

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
