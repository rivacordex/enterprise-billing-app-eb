import { beforeEach, describe, expect, it, vi } from "vitest";

// bm03-spec §Design/§6. `scopeAccounts` reads active accounts for the cycle,
// batches the subscription-window + transition reads, and splits the
// snapshot rows into PENDING / EXCLUDED via `isPartialPeriod`. Repositories
// are mocked (their SQL is covered by the repository-level structural tests);
// this suite proves the grouping/splitting logic.

vi.mock("@/db/repositories/accounts/billing-account.repository", () => ({
  billingAccountRepository: { findActiveByCycleId: vi.fn() },
}));
vi.mock("@/db/repositories/inventory/product-inventory.repository", () => ({
  productInventoryRepository: { findWindowsByBillingAccountIds: vi.fn() },
}));
vi.mock(
  "@/db/repositories/inventory/inventory-status-history.repository",
  () => ({
    inventoryStatusHistoryRepository: {
      findTransitionsByInventoryIds: vi.fn(),
    },
  }),
);

import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import { inventoryStatusHistoryRepository } from "@/db/repositories/inventory/inventory-status-history.repository";
import { scopeAccounts } from "@/services/billing/scope-accounts";

const mockFindActive = vi.mocked(billingAccountRepository.findActiveByCycleId);
const mockFindWindows = vi.mocked(
  productInventoryRepository.findWindowsByBillingAccountIds,
);
const mockFindTransitions = vi.mocked(
  inventoryStatusHistoryRepository.findTransitionsByInventoryIds,
);

const txStub = {} as never;
const RUN = {
  billRunId: "BRN00000001",
  refBillCycleId: "BCY00000001",
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindWindows.mockResolvedValue([]);
  mockFindTransitions.mockResolvedValue([]);
});

describe("scopeAccounts (bm03-spec §Design/§6)", () => {
  it("returns empty pending/excluded when the cycle has no active accounts", async () => {
    mockFindActive.mockResolvedValue([]);

    const result = await scopeAccounts(txStub, RUN);

    expect(result).toEqual({ pending: [], excluded: [] });
    expect(mockFindWindows).not.toHaveBeenCalled();
  });

  it("marks a full-period account PENDING with period_partition = 1st of period_start", async () => {
    mockFindActive.mockResolvedValue([{ billingAccountId: "BAN00000001" }]);
    mockFindWindows.mockResolvedValue([
      {
        productInventoryId: "PRDINV0001",
        billingAccountId: "BAN00000001",
        startDate: "2026-01-01",
        endDate: null,
      },
    ]);

    const result = await scopeAccounts(txStub, RUN);

    expect(result.excluded).toEqual([]);
    expect(result.pending).toEqual([
      {
        refBillRunId: "BRN00000001",
        refBillingAccountId: "BAN00000001",
        periodPartition: "2026-07-01",
        status: "PENDING",
        errorCode: null,
      },
    ]);
  });

  it("marks a mid-period-start account EXCLUDED with error_code PARTIAL_PERIOD", async () => {
    mockFindActive.mockResolvedValue([{ billingAccountId: "BAN00000002" }]);
    mockFindWindows.mockResolvedValue([
      {
        productInventoryId: "PRDINV0002",
        billingAccountId: "BAN00000002",
        startDate: "2026-07-15",
        endDate: null,
      },
    ]);

    const result = await scopeAccounts(txStub, RUN);

    expect(result.pending).toEqual([]);
    expect(result.excluded).toEqual([
      {
        refBillRunId: "BRN00000001",
        refBillingAccountId: "BAN00000002",
        periodPartition: "2026-07-01",
        status: "EXCLUDED",
        errorCode: "PARTIAL_PERIOD",
      },
    ]);
  });

  it("excludes an account whose subscription's suspend transition falls inside the window", async () => {
    mockFindActive.mockResolvedValue([{ billingAccountId: "BAN00000003" }]);
    mockFindWindows.mockResolvedValue([
      {
        productInventoryId: "PRDINV0003",
        billingAccountId: "BAN00000003",
        startDate: "2026-01-01",
        endDate: null,
      },
    ]);
    mockFindTransitions.mockResolvedValue([
      {
        productInventoryId: "PRDINV0003",
        fromStatus: "ACTIVE",
        toStatus: "SUSPENDED",
        effectiveDate: "2026-07-15",
      },
    ]);

    const result = await scopeAccounts(txStub, RUN);

    expect(result.pending).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]).toMatchObject({
      refBillingAccountId: "BAN00000003",
      status: "EXCLUDED",
      errorCode: "PARTIAL_PERIOD",
    });
  });

  it("only routes each account's own windows/transitions into its own predicate (no cross-account leakage)", async () => {
    mockFindActive.mockResolvedValue([
      { billingAccountId: "BAN00000001" },
      { billingAccountId: "BAN00000002" },
    ]);
    mockFindWindows.mockResolvedValue([
      {
        productInventoryId: "PRDINV0001",
        billingAccountId: "BAN00000001",
        startDate: "2026-01-01",
        endDate: null,
      },
      {
        productInventoryId: "PRDINV0002",
        billingAccountId: "BAN00000002",
        startDate: "2026-07-15", // partial — BAN2 only
        endDate: null,
      },
    ]);

    const result = await scopeAccounts(txStub, RUN);

    expect(result.pending.map((r) => r.refBillingAccountId)).toEqual([
      "BAN00000001",
    ]);
    expect(result.excluded.map((r) => r.refBillingAccountId)).toEqual([
      "BAN00000002",
    ]);
  });

  it("treats an account with no subscriptions as full-period (PENDING, not excluded)", async () => {
    mockFindActive.mockResolvedValue([{ billingAccountId: "BAN00000004" }]);
    mockFindWindows.mockResolvedValue([]);

    const result = await scopeAccounts(txStub, RUN);

    expect(result.pending).toEqual([
      {
        refBillRunId: "BRN00000001",
        refBillingAccountId: "BAN00000004",
        periodPartition: "2026-07-01",
        status: "PENDING",
        errorCode: null,
      },
    ]);
  });

  it("skips the transitions read when there are no subscription windows at all", async () => {
    mockFindActive.mockResolvedValue([{ billingAccountId: "BAN00000005" }]);
    mockFindWindows.mockResolvedValue([]);

    await scopeAccounts(txStub, RUN);

    expect(mockFindTransitions).not.toHaveBeenCalled();
  });
});
