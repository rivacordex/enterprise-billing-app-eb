import { beforeEach, describe, expect, it, vi } from "vitest";

// bm04-spec §Design/§Implementation §8/§31 — the Validation stage's readiness
// gate. Pass → DONE; missing/broken profile → HARD/UNRESOLVABLE_PROFILE.

vi.mock("@/db/repositories/accounts/billing-account.repository", () => ({
  billingAccountRepository: { findById: vi.fn() },
}));
vi.mock("@/db/repositories/accounts/bill-cycle.repository", () => ({
  billCycleRepository: { findById: vi.fn() },
}));

import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { validateAccount } from "@/services/billing/validate-account";

const mockFindAccount = vi.mocked(billingAccountRepository.findById);
const mockFindCycle = vi.mocked(billCycleRepository.findById);

const txStub = {} as never;

function account(overrides: Record<string, unknown> = {}) {
  return {
    billingAccountId: "BAN00000001",
    currency: "MYR",
    refBillCycleId: "BCY00000001",
    paymentDueDaysOverride: null,
    ...overrides,
  } as never;
}

function cycle(overrides: Record<string, unknown> = {}) {
  return {
    billCycleId: "BCY00000001",
    paymentDueDays: 30,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateAccount (bm04-spec §31)", () => {
  it("passes a healthy account: DONE, no error class", async () => {
    mockFindAccount.mockResolvedValue(account());
    mockFindCycle.mockResolvedValue(cycle());

    const result = await validateAccount(txStub, "BAN00000001");

    expect(result).toEqual({
      status: "DONE",
      errorClass: null,
      errorCode: null,
      errorDetail: null,
    });
  });

  it("resolves an overridden payment term via resolveTerm", async () => {
    mockFindAccount.mockResolvedValue(account({ paymentDueDaysOverride: 45 }));
    mockFindCycle.mockResolvedValue(cycle());

    const result = await validateAccount(txStub, "BAN00000001");

    expect(result.status).toBe("DONE");
  });

  it("HARD/UNRESOLVABLE_PROFILE when the account cannot be found", async () => {
    mockFindAccount.mockResolvedValue(null);

    const result = await validateAccount(txStub, "BAN00000099");

    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("HARD");
    expect(result.errorCode).toBe("UNRESOLVABLE_PROFILE");
    expect(mockFindCycle).not.toHaveBeenCalled();
  });

  it("HARD/UNRESOLVABLE_PROFILE when currency is null", async () => {
    mockFindAccount.mockResolvedValue(account({ currency: null }));

    const result = await validateAccount(txStub, "BAN00000001");

    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("HARD");
    expect(result.errorCode).toBe("UNRESOLVABLE_PROFILE");
  });

  it("HARD/UNRESOLVABLE_PROFILE when the bill cycle cannot be resolved", async () => {
    mockFindAccount.mockResolvedValue(account());
    mockFindCycle.mockResolvedValue(null);

    const result = await validateAccount(txStub, "BAN00000001");

    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("HARD");
    expect(result.errorCode).toBe("UNRESOLVABLE_PROFILE");
  });
});
