import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// cm20-spec §3.8 — mocked repositories; mock @/db/client so importing the
// service never triggers lib/config's eager env validation.
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/accounts/financial-account.repository", () => ({
  financialAccountRepository: { findByPartyRoleIds: vi.fn() },
}));
vi.mock("@/db/repositories/accounts/billing-account.repository", () => ({
  billingAccountRepository: { findByFinancialAccountId: vi.fn() },
}));
vi.mock("@/db/repositories/accounts/bill-cycle.repository", () => ({
  billCycleRepository: { findById: vi.fn() },
}));
vi.mock("@/db/repositories/accounts/ledger.repository", () => ({
  ledgerRepository: { receivablesByFinancialAccount: vi.fn() },
}));
vi.mock("@/db/repositories/system-config.repository", () => ({
  systemConfigRepository: { findActiveValue: vi.fn() },
}));
vi.mock("@/services/accounts/get-financial-account-detail", () => ({
  getFinancialAccountDetail: vi.fn(),
}));
vi.mock("@/services/accounts/list-transaction-documents", () => ({
  listTransactionDocuments: vi.fn(),
}));
vi.mock("@/services/accounts/resolve-ban-template-label", async () => {
  const actual = await vi.importActual<typeof LabelModule>(
    "@/services/accounts/resolve-ban-template-label",
  );
  return { ...actual, resolveCurrentTemplateLabel: vi.fn() };
});
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { stripComments } from "@/tests/helpers/strip-code-comments";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { logger } from "@/lib/logger";
import {
  getCustomerAccountsSummary,
  resolveDocumentsPageSize,
} from "@/services/accounts/get-customer-accounts-summary";
import { getFinancialAccountDetail } from "@/services/accounts/get-financial-account-detail";
import { listTransactionDocuments } from "@/services/accounts/list-transaction-documents";
import { resolveCurrentTemplateLabel } from "@/services/accounts/resolve-ban-template-label";
import type * as LabelModule from "@/services/accounts/resolve-ban-template-label";
import type {
  BillCycle,
  BillingAccount,
  FinancialAccount,
  TransactionDocumentRow,
} from "@/types/accounts";

const mockFindFas = vi.mocked(financialAccountRepository.findByPartyRoleIds);
const mockFindBans = vi.mocked(
  billingAccountRepository.findByFinancialAccountId,
);
const mockFindCycle = vi.mocked(billCycleRepository.findById);
const mockReceivables = vi.mocked(
  ledgerRepository.receivablesByFinancialAccount,
);
const mockConfig = vi.mocked(systemConfigRepository.findActiveValue);
const mockFaDetail = vi.mocked(getFinancialAccountDetail);
const mockListDocs = vi.mocked(listTransactionDocuments);
const mockCurrentLabel = vi.mocked(resolveCurrentTemplateLabel);

const FA = {
  financialAccountId: "FIN00000001",
  state: "active",
  currency: "MYR",
} as FinancialAccount;

function ban(overrides: Partial<BillingAccount>): BillingAccount {
  return {
    billingAccountId: "BAN00000001",
    name: "Master Billing Account",
    state: "active",
    refBillCycleId: "BCY00000001",
    paymentDueDaysOverride: null,
    refBillTemplateVersionId: null,
    ...overrides,
  } as BillingAccount;
}

const CYCLE = {
  billCycleId: "BCY00000001",
  name: "Monthly – Day 1",
  paymentDueDays: 30,
} as BillCycle;

const DOC = {
  documentId: "DBN00000001",
  actionLabel: "Debit Note — X",
} as TransactionDocumentRow;

beforeEach(() => {
  vi.clearAllMocks();
  mockFindFas.mockResolvedValue([FA]);
  mockFindBans.mockResolvedValue([ban({})]);
  mockFindCycle.mockResolvedValue(CYCLE);
  mockReceivables.mockResolvedValue(new Map([["BAN00000001", "500.00"]]));
  mockConfig.mockResolvedValue("20");
  mockFaDetail.mockResolvedValue({
    receivableBalance: "500.00",
    unappliedCashBalance: "10.00",
    depositBalance: "0.00",
  } as Awaited<ReturnType<typeof getFinancialAccountDetail>>);
  mockListDocs.mockResolvedValue({ rows: [DOC], total: 1 });
  mockCurrentLabel.mockResolvedValue("INVTPL-STD-A4 v1");
});

describe("getCustomerAccountsSummary", () => {
  it("no FA → notOnboarded, and nothing else is read", async () => {
    mockFindFas.mockResolvedValue([]);

    await expect(
      getCustomerAccountsSummary("PTRL00000001", 1),
    ).resolves.toEqual({ kind: "notOnboarded" });
    expect(mockFindFas).toHaveBeenCalledWith({}, ["PTRL00000001"]);
    expect(mockFaDetail).not.toHaveBeenCalled();
    expect(mockListDocs).not.toHaveBeenCalled();
    expect(mockConfig).not.toHaveBeenCalled();
  });

  it("FA + BAN + docs → the full shape", async () => {
    const result = await getCustomerAccountsSummary("PTRL00000001", 2);

    expect(result).toEqual({
      kind: "onboarded",
      financialAccounts: [
        {
          financialAccountId: "FIN00000001",
          state: "active",
          currency: "MYR",
          receivableBalance: "500.00",
          unappliedCashBalance: "10.00",
          depositBalance: "0.00",
          bans: [
            {
              billingAccountId: "BAN00000001",
              name: "Master Billing Account",
              state: "active",
              billCycleName: "Monthly – Day 1",
              paymentTermDays: 30,
              receivableBalance: "500.00",
              templateLabel:
                "Follows active template (currently: INVTPL-STD-A4 v1), as of now",
            },
          ],
          documents: { rows: [DOC], total: 1, page: 2, pageSize: 20 },
        },
      ],
    });
    expect(mockListDocs).toHaveBeenCalledWith(
      "FIN00000001",
      null,
      {
        type: null,
        status: null,
        rev: null,
        q: "",
        sort: "-event_at",
        page: 2,
      },
      20,
    );
    expect(mockCurrentLabel).toHaveBeenCalledTimes(1);
  });

  it("a BAN with no binding gets receivable '0.00'", async () => {
    mockReceivables.mockResolvedValue(new Map());

    const result = await getCustomerAccountsSummary("PTRL00000001", 1);

    if (result.kind !== "onboarded") throw new Error("expected onboarded");
    expect(result.financialAccounts[0]!.bans[0]!.receivableBalance).toBe(
      "0.00",
    );
  });

  it("the payment term resolves the BAN override over the cycle default", async () => {
    mockFindBans.mockResolvedValue([ban({ paymentDueDaysOverride: 14 })]);

    const result = await getCustomerAccountsSummary("PTRL00000001", 1);

    if (result.kind !== "onboarded") throw new Error("expected onboarded");
    expect(result.financialAccounts[0]!.bans[0]!.paymentTermDays).toBe(14);
  });

  it("reads each distinct bill cycle once", async () => {
    mockFindBans.mockResolvedValue([
      ban({ billingAccountId: "BAN00000001" }),
      ban({ billingAccountId: "BAN00000002" }),
      ban({ billingAccountId: "BAN00000003", refBillCycleId: "BCY00000002" }),
    ]);
    mockFindCycle.mockImplementation(async (_db, id) => ({
      ...CYCLE,
      billCycleId: id,
    }));

    await getCustomerAccountsSummary("PTRL00000001", 1);

    expect(mockFindCycle).toHaveBeenCalledTimes(2);
    expect(mockFindCycle.mock.calls.map((c) => c[1]).sort()).toEqual([
      "BCY00000001",
      "BCY00000002",
    ]);
    expect(mockReceivables).toHaveBeenCalledTimes(1);
  });

  it("a non-NULL template reference → 'not supported' label and a warning, never resolved", async () => {
    mockFindBans.mockResolvedValue([
      ban({ refBillTemplateVersionId: "BTV00000002" }),
    ]);

    const result = await getCustomerAccountsSummary("PTRL00000001", 1);

    if (result.kind !== "onboarded") throw new Error("expected onboarded");
    expect(result.financialAccounts[0]!.bans[0]!.templateLabel).toBe(
      "Template reference not supported yet",
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("resolveDocumentsPageSize", () => {
  it.each([
    [null, 20],
    ["abc", 20],
    ["0", 20],
    ["-5", 20],
    ["", 20],
    ["15", 15],
    ["100", 100],
    ["500", 100],
  ])("config %s → %d", async (raw, expected) => {
    mockConfig.mockResolvedValue(raw);
    await expect(resolveDocumentsPageSize()).resolves.toBe(expected);
    expect(mockConfig).toHaveBeenCalledWith(
      {},
      "customer",
      "CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE",
    );
  });
});

describe("static import check (Inv. #11)", () => {
  it.each([
    "services/accounts/get-customer-accounts-summary.ts",
    "services/accounts/resolve-ban-template-label.ts",
  ])(
    "%s imports nothing from actions/**, post-document or the posting resolver",
    (file) => {
      const source = fs.readFileSync(path.resolve(file), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
        (m) => m[1],
      );
      for (const spec of imports) {
        expect(spec).not.toMatch(/^@\/actions\//);
        expect(spec).not.toMatch(/post-document/);
        expect(spec).not.toMatch(/resolve-template/);
      }
      expect(stripComments(source)).not.toMatch(
        /resolveTemplate|resolveVersionsForPosting/,
      );
    },
  );
});
