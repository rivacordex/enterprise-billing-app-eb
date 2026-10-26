// cm20 (binding plan §7.2, custmgmt Inv. #11/#13/#15) — the one Accounts-side
// read service behind the View Customer Accounts tab. Read-only: no writes, no
// transaction, no import from actions/**, post-document or any pgledger
// function wrapper beyond the ledger read methods below.
//
// Query budget per FA (expected 1): getFinancialAccountDetail (constant), BAN
// rows, ONE grouped per-BAN receivables read, one document page (two when the
// requested page is past the end and is clamped); then one
// bill-cycle read per distinct cycle. Accounts are found by the party-role key,
// never party_role.account (Inv. #13).

import { db } from "@/db/client";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { getFinancialAccountDetail } from "@/services/accounts/get-financial-account-detail";
import { listTransactionDocuments } from "@/services/accounts/list-transaction-documents";
import { sum } from "@/services/accounts/money";
import {
  resolveBanTemplateLabels,
  templateLabelFor,
} from "@/services/accounts/resolve-ban-template-label";
import { resolveTerm } from "@/services/accounts/term-resolution";
import type {
  AccountState,
  BillCycle,
  CustomerAccountsSummary,
  TransactionDocumentRow,
} from "@/types/accounts";

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

// One page of an FA's documents. An out-of-range page (a stale link, a
// hand-edited URL, or documents that have since dropped below the page) is
// clamped to the last page, so the table never renders an empty header with
// a Previous link that only steps back one page. Costs a second read only in
// that case.
async function documentsPage(
  financialAccountId: string,
  page: number,
  pageSize: number,
): Promise<{ rows: TransactionDocumentRow[]; total: number; page: number }> {
  const read = (p: number) =>
    listTransactionDocuments(
      financialAccountId,
      null,
      {
        type: null,
        status: null,
        rev: null,
        q: "",
        sort: "-event_at",
        page: p,
      },
      pageSize,
    );
  const first = await read(page);
  const lastPage = Math.max(1, Math.ceil(first.total / pageSize));
  if (page <= lastPage) return { ...first, page };
  return { ...(await read(lastPage)), page: lastPage };
}

// `page` applies to the FA named by `pageFinancialAccountId`; every other FA
// shows page 1. `null` applies `page` to every FA (single-FA deep links).
export async function getCustomerAccountsSummary(
  partyRoleId: string,
  page: number,
  pageFinancialAccountId: string | null = null,
): Promise<CustomerAccountsSummary> {
  const fas = await financialAccountRepository.findByPartyRoleIds(db, [
    partyRoleId,
  ]);
  if (fas.length === 0) return { kind: "notOnboarded" };

  const pageSize = await resolveDocumentsPageSize();

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
        documentsPage(
          faId,
          pageFinancialAccountId === null || pageFinancialAccountId === faId
            ? page
            : 1,
          pageSize,
        ),
      ]);
      if (detail === null) {
        throw new Error(`financial account ${faId} not found`);
      }
      return { fa, detail, bans, receivables, documents };
    }),
  );

  const labels = await resolveBanTemplateLabels(
    db,
    perFa.flatMap((f) => f.bans.map((b) => b.refBillTemplateFamilyId)),
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
        state: fa.state as AccountState,
        currency: fa.currency,
        // Summed from the same per-BAN read the BAN cards show, so the FA
        // total always equals the sum of its BAN cards (one snapshot), rather
        // than a second, separately timed ledger query.
        receivableBalance: sum(
          ...bans.map((ban) => receivables.get(ban.billingAccountId) ?? "0.00"),
        ),
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
            return {
              billingAccountId: ban.billingAccountId,
              name: ban.name,
              state: ban.state as AccountState,
              currency: ban.currency,
              billCycleName: cycle.name,
              paymentTermDays: resolveTerm(
                ban.paymentDueDaysOverride ?? null,
                cycle.paymentDueDays,
              ),
              receivableBalance:
                receivables.get(ban.billingAccountId) ?? "0.00",
              templateLabel: templateLabelFor(
                labels,
                ban.refBillTemplateFamilyId,
              ),
            };
          }),
        documents: {
          rows: documents.rows,
          total: documents.total,
          page: documents.page,
          pageSize,
        },
      }),
    ),
  };
}
