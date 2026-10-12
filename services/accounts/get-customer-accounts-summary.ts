// cm20 (binding plan §7.2, custmgmt Inv. #11/#13/#15) — the one Accounts-side
// read service behind the View Customer Accounts tab. Read-only: no writes, no
// transaction, no import from actions/**, post-document or any pgledger
// function wrapper beyond the ledger read methods below.
//
// Query budget per FA (expected 1): getFinancialAccountDetail (constant), BAN
// rows, ONE grouped per-BAN receivables read, one document page; then one
// bill-cycle read per distinct cycle. Accounts are found by the party-role key,
// never party_role.account (Inv. #13).

import { db } from "@/db/client";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { logger } from "@/lib/logger";
import { getFinancialAccountDetail } from "@/services/accounts/get-financial-account-detail";
import { listTransactionDocuments } from "@/services/accounts/list-transaction-documents";
import {
  banTemplateLabel,
  resolveCurrentTemplateLabel,
} from "@/services/accounts/resolve-ban-template-label";
import { resolveTerm } from "@/services/accounts/term-resolution";
import type { BillCycle, CustomerAccountsSummary } from "@/types/accounts";

export const DEFAULT_CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE = 20;
export const MAX_CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE = 100;

const PAGE_SIZE_REGEX = /^\d+$/;

// `customer` / `CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE` (seeded by
// db/seeds/customer.ts). Same graceful fallback as CUSTOMER_SEARCH_RESULT_LIMIT
// (services/customer/search-customers.ts): missing / non-numeric / `< 1` → 20;
// capped at 100. A corrupt row degrades, it never 500s.
export async function resolveDocumentsPageSize(): Promise<number> {
  const raw = await systemConfigRepository.findActiveValue(
    db,
    "customer",
    "CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE",
  );
  if (raw === null || !PAGE_SIZE_REGEX.test(raw)) {
    return DEFAULT_CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE;
  }
  const value = Number(raw);
  if (value < 1) return DEFAULT_CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE;
  return Math.min(value, MAX_CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE);
}

export async function getCustomerAccountsSummary(
  partyRoleId: string,
  page: number,
): Promise<CustomerAccountsSummary> {
  const fas = await financialAccountRepository.findByPartyRoleIds(db, [
    partyRoleId,
  ]);
  if (fas.length === 0) return { kind: "notOnboarded" };

  const [pageSize, currentLabel] = await Promise.all([
    resolveDocumentsPageSize(),
    resolveCurrentTemplateLabel(db),
  ]);

  const sorted = [...fas].sort((a, b) =>
    a.financialAccountId.localeCompare(b.financialAccountId),
  );

  const perFa = await Promise.all(
    sorted.map(async (fa) => {
      const faId = fa.financialAccountId;
      const [detail, bans, receivables, documents] = await Promise.all([
        getFinancialAccountDetail(faId),
        billingAccountRepository.findByFinancialAccountId(db, faId),
        ledgerRepository.receivablesByFinancialAccount(db, faId),
        listTransactionDocuments(
          faId,
          null,
          {
            type: null,
            status: null,
            rev: null,
            q: "",
            sort: "-event_at",
            page,
          },
          pageSize,
        ),
      ]);
      if (detail === null) {
        throw new Error(`financial account ${faId} not found`);
      }
      return { fa, detail, bans, receivables, documents };
    }),
  );

  const cycleIds = [
    ...new Set(perFa.flatMap((f) => f.bans.map((b) => b.refBillCycleId))),
  ];
  const cycleRows = await Promise.all(
    cycleIds.map((id) => billCycleRepository.findById(db, id)),
  );
  const cycles = new Map<string, BillCycle>();
  for (const cycle of cycleRows) {
    if (cycle !== null) cycles.set(cycle.billCycleId, cycle);
  }

  return {
    kind: "onboarded",
    financialAccounts: perFa.map(
      ({ fa, detail, bans, receivables, documents }) => ({
        financialAccountId: fa.financialAccountId,
        state: fa.state,
        currency: fa.currency,
        receivableBalance: detail.receivableBalance,
        unappliedCashBalance: detail.unappliedCashBalance,
        depositBalance: detail.depositBalance,
        bans: [...bans]
          .sort((a, b) => a.billingAccountId.localeCompare(b.billingAccountId))
          .map((ban) => {
            const cycle = cycles.get(ban.refBillCycleId);
            if (cycle === undefined) {
              throw new Error(
                `bill cycle ${ban.refBillCycleId} not found for ${ban.billingAccountId}`,
              );
            }
            if (ban.refBillTemplateVersionId !== null) {
              // Unreachable in v1 (cm18/cm21 reject it); never resolved here.
              logger.warn("Unsupported BAN invoice template reference.", {
                billingAccountId: ban.billingAccountId,
                refBillTemplateVersionId: ban.refBillTemplateVersionId,
              });
            }
            return {
              billingAccountId: ban.billingAccountId,
              name: ban.name,
              state: ban.state as "active" | "suspended" | "closed",
              billCycleName: cycle.name,
              paymentTermDays: resolveTerm(
                ban.paymentDueDaysOverride ?? null,
                cycle.paymentDueDays,
              ),
              receivableBalance:
                receivables.get(ban.billingAccountId) ?? "0.00",
              templateLabel: banTemplateLabel(
                ban.refBillTemplateVersionId,
                currentLabel,
              ),
            };
          }),
        documents: {
          rows: documents.rows,
          total: documents.total,
          page,
          pageSize,
        },
      }),
    ),
  };
}
