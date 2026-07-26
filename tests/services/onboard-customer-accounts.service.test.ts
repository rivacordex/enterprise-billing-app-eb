import { beforeEach, describe, expect, it, vi } from "vitest";

const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));

vi.mock("@/db/repositories/party-role", () => ({
  partyRoleRepository: {
    findById: vi.fn(),
    compareAndUpdateStatus: vi.fn(),
  },
}));
vi.mock("@/db/repositories/accounts/bill-cycle.repository", () => ({
  billCycleRepository: { findById: vi.fn() },
}));
vi.mock("@/db/repositories/accounts/financial-account.repository", () => ({
  financialAccountRepository: { insert: vi.fn() },
}));
vi.mock("@/db/repositories/accounts/billing-account.repository", () => ({
  billingAccountRepository: { insert: vi.fn() },
}));
vi.mock("@/db/repositories/accounts/ledger-binding.repository", () => ({
  ledgerBindingRepository: { insert: vi.fn() },
}));
vi.mock("@/db/repositories/accounts/ledger.repository", () => ({
  ledgerRepository: { createAccount: vi.fn() },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));

import { partyRoleRepository } from "@/db/repositories/party-role";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { resolveTerm } from "@/services/accounts/term-resolution";
import type { OnboardCustomerAccountsInput } from "@/validation/accounts/onboard-customer-accounts.schema";

const mockFindById = vi.mocked(partyRoleRepository.findById);
const mockCompareAndUpdateStatus = vi.mocked(
  partyRoleRepository.compareAndUpdateStatus,
);
const mockCycleFindById = vi.mocked(billCycleRepository.findById);
const mockFaInsert = vi.mocked(financialAccountRepository.insert);
const mockBanInsert = vi.mocked(billingAccountRepository.insert);
const mockBindingInsert = vi.mocked(ledgerBindingRepository.insert);
const mockCreateAccount = vi.mocked(ledgerRepository.createAccount);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

const LOCK = new Date("2026-01-01T00:00:00.000Z");
const BUMPED = new Date("2026-01-01T00:00:01.000Z");

function buildInput(
  overrides: Partial<OnboardCustomerAccountsInput> = {},
): OnboardCustomerAccountsInput {
  return {
    partyRoleId: "PTRL00000001",
    billCycleId: "BCY000001",
    currency: "MYR",
    statusReason: "All KYC checks passed.",
    lastModifiedDatetime: LOCK,
    ...overrides,
  };
}

function buildPartyRole(status = "INITIALIZED", lastModifiedDatetime = LOCK) {
  return {
    partyRoleId: "PTRL00000001",
    engagedParty: "ORG00000001",
    status,
    statusReason: null,
    partyRoleSpecification: {},
    account: null,
    contactMedium: null,
    lastModifiedBy: "actor-1",
    createdDatetime: new Date(),
    lastModifiedDatetime,
  } as never;
}

function buildActiveCycle() {
  return {
    billCycleId: "BCY000001",
    name: "Monthly – Day 1",
    state: "active",
    frequency: "monthly",
    cycleDay: 1,
    paymentDueDays: 30,
    lastModified: new Date(),
    lastEditedBy: null,
  } as never;
}

function buildFa(financialAccountId = "FIN000001") {
  return {
    financialAccountId,
    name: "Financial Account",
    state: "active",
    refPartyRoleId: "PTRL00000001",
    currency: "MYR",
    creditLimitAmount: null,
    description: null,
    contact: null,
    lastModified: new Date(),
    lastEditedBy: "actor-1",
  } as never;
}

function buildBan(billingAccountId = "BAN000001") {
  return {
    billingAccountId,
    name: "Master Billing Account",
    state: "active",
    refPartyRoleId: "PTRL00000001",
    refFinancialAccountId: "FIN000001",
    currency: "MYR",
    ratingType: "postpaid",
    paymentStatus: "paid",
    creditLimitAmount: null,
    description: null,
    contact: null,
    refBillCycleId: "BCY000001",
    paymentDueDaysOverride: null,
    defaultPaymentMethodRef: null,
    lastModified: new Date(),
    lastEditedBy: "actor-1",
  } as never;
}

function setupHappyPath(): void {
  mockFindById.mockResolvedValue(buildPartyRole());
  mockCycleFindById.mockResolvedValue(buildActiveCycle());
  mockCompareAndUpdateStatus.mockResolvedValue(
    buildPartyRole("VALIDATED", BUMPED),
  );
  mockFaInsert.mockResolvedValue(buildFa());
  mockBanInsert.mockResolvedValue(buildBan());
  mockCreateAccount
    .mockResolvedValueOnce({ id: "pgla-uc" })
    .mockResolvedValueOnce({ id: "pgla-dep" })
    .mockResolvedValueOnce({ id: "pgla-rec" });
  mockBindingInsert.mockResolvedValue({} as never);
  mockInsertAuditEvent.mockResolvedValue(undefined);
}

beforeEach(() => {
  mockFindById.mockReset();
  mockCycleFindById.mockReset();
  mockCompareAndUpdateStatus.mockReset();
  mockFaInsert.mockReset();
  mockBanInsert.mockReset();
  mockBindingInsert.mockReset();
  mockCreateAccount.mockReset();
  mockInsertAuditEvent.mockReset();
});

// ── resolveTerm (ac04-spec §2.7) ──────────────────────────────────────────
describe("resolveTerm", () => {
  it("returns override when set", () => {
    expect(resolveTerm(45, 30)).toBe(45);
  });

  it("returns cycle default when override is null", () => {
    expect(resolveTerm(null, 30)).toBe(30);
  });

  it("returns cycle default when override is undefined", () => {
    expect(resolveTerm(undefined, 30)).toBe(30);
  });

  it("returns 0 override (falsy but valid)", () => {
    // Override of 0 is not a valid positive int (schema rejects it), but the
    // pure function doesn't enforce that — 0 is a defined value, not null.
    expect(resolveTerm(0, 30)).toBe(0);
  });
});

// ── onboardCustomerAccounts ───────────────────────────────────────────────
describe("onboardCustomerAccounts", () => {
  it("PARTY_ROLE_NOT_FOUND when party role does not exist", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await onboardCustomerAccounts(buildInput(), "actor-1");

    expect(result).toEqual({ ok: false, code: "PARTY_ROLE_NOT_FOUND" });
    expect(mockCompareAndUpdateStatus).not.toHaveBeenCalled();
  });

  it("INVALID_TRANSITION when party role is not INITIALIZED", async () => {
    mockFindById.mockResolvedValue(buildPartyRole("VALIDATED"));

    const result = await onboardCustomerAccounts(buildInput(), "actor-1");

    expect(result).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(mockCompareAndUpdateStatus).not.toHaveBeenCalled();
  });

  it("CYCLE_RETIRED when the bill cycle is retired", async () => {
    mockFindById.mockResolvedValue(buildPartyRole());
    mockCycleFindById.mockResolvedValue({
      billCycleId: "BCY000001",
      name: "Monthly – Day 1",
      state: "retired",
      frequency: "monthly",
      cycleDay: 1,
      paymentDueDays: 30,
      lastModified: new Date(),
      lastEditedBy: null,
    } as never);

    const result = await onboardCustomerAccounts(buildInput(), "actor-1");

    expect(result).toEqual({ ok: false, code: "CYCLE_RETIRED" });
    expect(mockCompareAndUpdateStatus).not.toHaveBeenCalled();
  });

  it("CYCLE_RETIRED when the bill cycle does not exist", async () => {
    mockFindById.mockResolvedValue(buildPartyRole());
    mockCycleFindById.mockResolvedValue(null);

    const result = await onboardCustomerAccounts(buildInput(), "actor-1");

    expect(result).toEqual({ ok: false, code: "CYCLE_RETIRED" });
  });

  it("CONFLICT when compareAndUpdateStatus returns null (stale lock)", async () => {
    mockFindById.mockResolvedValue(buildPartyRole());
    mockCycleFindById.mockResolvedValue(buildActiveCycle());
    mockCompareAndUpdateStatus.mockResolvedValue(null);

    const result = await onboardCustomerAccounts(buildInput(), "actor-1");

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockFaInsert).not.toHaveBeenCalled();
  });

  it("happy path — returns correct ids and ledger account names", async () => {
    setupHappyPath();

    const result = await onboardCustomerAccounts(buildInput(), "actor-1");

    expect(result).toEqual({
      ok: true,
      value: {
        financialAccountId: "FIN000001",
        billingAccountId: "BAN000001",
        ledgerAccountNames: [
          "fa.FIN000001.unapplied_cash",
          "fa.FIN000001.deposits",
          "ban.BAN000001.receivables",
        ],
        lastModifiedDatetime: BUMPED,
      },
    });
  });

  it("happy path — compareAndUpdateStatus called with VALIDATED + statusReason", async () => {
    setupHappyPath();

    await onboardCustomerAccounts(buildInput(), "actor-1");

    expect(mockCompareAndUpdateStatus).toHaveBeenCalledWith(
      txStub,
      "PTRL00000001",
      LOCK,
      {
        status: "VALIDATED",
        statusReason: "All KYC checks passed.",
        lastModifiedBy: "actor-1",
      },
    );
  });

  it("happy path — pgledger accounts created with correct names and currency", async () => {
    setupHappyPath();

    await onboardCustomerAccounts(buildInput(), "actor-1");

    expect(mockCreateAccount).toHaveBeenCalledTimes(3);
    expect(mockCreateAccount).toHaveBeenCalledWith(
      txStub,
      "fa.FIN000001.unapplied_cash",
      "MYR",
    );
    expect(mockCreateAccount).toHaveBeenCalledWith(
      txStub,
      "fa.FIN000001.deposits",
      "MYR",
    );
    expect(mockCreateAccount).toHaveBeenCalledWith(
      txStub,
      "ban.BAN000001.receivables",
      "MYR",
    );
  });

  it("happy path — three bindings inserted in correct order", async () => {
    setupHappyPath();

    await onboardCustomerAccounts(buildInput(), "actor-1");

    expect(mockBindingInsert).toHaveBeenCalledTimes(3);
    expect(mockBindingInsert).toHaveBeenNthCalledWith(
      1,
      txStub,
      expect.objectContaining({
        ownerType: "financial_account",
        ownerId: "FIN000001",
        ledgerRole: "unapplied_cash",
        pgledgerAccountId: "pgla-uc",
        lastEditedBy: "actor-1",
      }),
    );
    expect(mockBindingInsert).toHaveBeenNthCalledWith(
      2,
      txStub,
      expect.objectContaining({
        ownerType: "financial_account",
        ownerId: "FIN000001",
        ledgerRole: "deposits",
        pgledgerAccountId: "pgla-dep",
        lastEditedBy: "actor-1",
      }),
    );
    expect(mockBindingInsert).toHaveBeenNthCalledWith(
      3,
      txStub,
      expect.objectContaining({
        ownerType: "billing_account",
        ownerId: "BAN000001",
        ledgerRole: "receivables",
        pgledgerAccountId: "pgla-rec",
        lastEditedBy: "actor-1",
      }),
    );
  });

  it("happy path — ACCOUNTS_ONBOARDED audit event written inside the transaction", async () => {
    setupHappyPath();

    await onboardCustomerAccounts(buildInput(), "actor-1");

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "ACCOUNTS_ONBOARDED",
        actorUserId: "actor-1",
        targetEntity: "FINANCIAL_ACCOUNT",
        targetId: "FIN000001",
      }),
    );
  });

  it("FA insert called with correct fields including currency and actorId", async () => {
    setupHappyPath();

    await onboardCustomerAccounts(
      buildInput({ faCreditLimit: "5000.00" }),
      "actor-1",
    );

    expect(mockFaInsert).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        refPartyRoleId: "PTRL00000001",
        currency: "MYR",
        creditLimitAmount: "5000.00",
        lastEditedBy: "actor-1",
      }),
    );
  });

  it("BAN insert carries paymentDueDaysOverride when provided", async () => {
    setupHappyPath();

    await onboardCustomerAccounts(
      buildInput({ paymentDueDaysOverride: 45 }),
      "actor-1",
    );

    expect(mockBanInsert).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        paymentDueDaysOverride: 45,
        ratingType: "postpaid",
        paymentStatus: "paid",
        refBillCycleId: "BCY000001",
      }),
    );
  });
});
