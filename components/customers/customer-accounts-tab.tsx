// cm20 (binding plan §7.2, D14) — the View Customer Accounts tab body for the
// not-onboarded and onboarded states. Presentational: the summary is fetched
// in the app layer (components/** may not import services/** under the
// boundaries rule) and the locked state never reaches this component — the
// page renders AccountsLockedCard instead (Inv. #12).

import { AccountsNotOnboardedCard } from "@/components/customers/accounts-not-onboarded-card";
import { BillingAccountCard } from "@/components/customers/billing-account-card";
import { CustomerDocumentsTable } from "@/components/customers/customer-documents-table";
import { FinancialAccountSummaryCard } from "@/components/customers/financial-account-summary-card";
import type { CustomerAccountsSummary } from "@/types/accounts";

export interface CustomerAccountsTabProps {
  partyRoleId: string;
  summary: CustomerAccountsSummary;
  locale: string;
  timezone: string;
}

export function CustomerAccountsTab({
  partyRoleId,
  summary,
  locale,
  timezone,
}: CustomerAccountsTabProps): React.JSX.Element {
  if (summary.kind === "notOnboarded") {
    return <AccountsNotOnboardedCard />;
  }

  return (
    <div className="space-y-6">
      {summary.financialAccounts.map((fa) => (
        <div key={fa.financialAccountId} className="space-y-4">
          <FinancialAccountSummaryCard
            financialAccountId={fa.financialAccountId}
            currency={fa.currency}
            receivableBalance={fa.receivableBalance}
            unappliedCashBalance={fa.unappliedCashBalance}
            depositBalance={fa.depositBalance}
          />
          {fa.bans.map((ban) => (
            <BillingAccountCard
              key={ban.billingAccountId}
              billingAccountId={ban.billingAccountId}
              name={ban.name}
              state={ban.state}
              billCycleName={ban.billCycleName}
              paymentTermDays={ban.paymentTermDays}
              receivableBalance={ban.receivableBalance}
              currency={fa.currency}
              templateLabel={ban.templateLabel}
            />
          ))}
          <section aria-label="Transactions" className="space-y-2">
            <h3 className="text-h3 font-semibold text-foreground">
              Transactions
            </h3>
            <CustomerDocumentsTable
              partyRoleId={partyRoleId}
              financialAccountId={fa.financialAccountId}
              rows={fa.documents.rows}
              total={fa.documents.total}
              page={fa.documents.page}
              pageSize={fa.documents.pageSize}
              locale={locale}
              timezone={timezone}
            />
          </section>
        </div>
      ))}
    </div>
  );
}
