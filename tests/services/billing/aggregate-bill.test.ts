import { beforeEach, describe, expect, it, vi } from "vitest";

// bm05-spec §Design/§Implementation §4. Aggregation: resolves the payment
// term (coalesce(account override, cycle default)), computes
// payment_due_date = scheduled_run_date + term days, and writes a
// deterministic synthetic stub subtotal via a rerun-safe conditional
// DELETE + INSERT.

vi.mock("@/db/repositories/accounts/billing-account.repository", () => ({
  billingAccountRepository: { findById: vi.fn() },
}));
vi.mock("@/db/repositories/accounts/bill-cycle.repository", () => ({
  billCycleRepository: { findById: vi.fn() },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: { deleteTrial: vi.fn(), insertTrial: vi.fn() },
}));

import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import {
  aggregateBill,
  deriveStubSubtotal,
} from "@/services/billing/aggregate-bill";

const mockFindAccount = vi.mocked(billingAccountRepository.findById);
const mockFindCycle = vi.mocked(billCycleRepository.findById);
const mockDeleteTrial = vi.mocked(customerBillRepository.deleteTrial);
const mockInsertTrial = vi.mocked(customerBillRepository.insertTrial);

const txStub = {} as never;

function account(overrides: Record<string, unknown> = {}) {
  return {
    billingAccountId: "BAN00000001",
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

const RUN = {
  billRunId: "BRN00000001",
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
  scheduledRunDate: "2026-08-01",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindAccount.mockResolvedValue(account());
  mockFindCycle.mockResolvedValue(cycle());
  mockDeleteTrial.mockResolvedValue(undefined);
  mockInsertTrial.mockResolvedValue(undefined);
});

describe("aggregateBill (bm05-spec §4)", () => {
  it("deletes any existing un-posted trial before inserting the new one (rerun-safe)", async () => {
    await aggregateBill(txStub, RUN, "BAN00000001");

    expect(mockDeleteTrial).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "BAN00000001",
    );
    const deleteOrder = mockDeleteTrial.mock.invocationCallOrder[0];
    const insertOrder = mockInsertTrial.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(insertOrder as number);
  });

  it("writes category=trial, state=new, the run's period as the billing period", async () => {
    await aggregateBill(txStub, RUN, "BAN00000001");

    expect(mockInsertTrial).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        refBillRunId: "BRN00000001",
        refBillingAccountId: "BAN00000001",
        periodPartition: "2026-07-01",
        category: "trial",
        state: "new",
        billingPeriodStart: "2026-07-01",
        billingPeriodEnd: "2026-07-31",
      }),
    );
  });

  it("resolves payment_due_date from the cycle default (scheduled_run_date + term days)", async () => {
    mockFindCycle.mockResolvedValue(cycle({ paymentDueDays: 14 }));

    await aggregateBill(txStub, RUN, "BAN00000001");

    expect(mockInsertTrial).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({ paymentDueDate: "2026-08-15" }),
    );
  });

  it("resolves payment_due_date from the account override when present", async () => {
    mockFindAccount.mockResolvedValue(account({ paymentDueDaysOverride: 45 }));

    await aggregateBill(txStub, RUN, "BAN00000001");

    expect(mockInsertTrial).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({ paymentDueDate: "2026-09-15" }),
    );
  });

  it("writes tax_total 0.00 and total_amount equal to the subtotal (taxation is bm06)", async () => {
    await aggregateBill(txStub, RUN, "BAN00000001");

    const [, row] = mockInsertTrial.mock.calls[0] as [
      unknown,
      { subtotal: string; taxTotal: string; totalAmount: string },
    ];
    expect(row.taxTotal).toBe("0.00");
    expect(row.totalAmount).toBe(row.subtotal);
  });

  it("throws when the billing account cannot be resolved", async () => {
    mockFindAccount.mockResolvedValue(null);

    await expect(
      aggregateBill(txStub, RUN, "BAN00000099"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockInsertTrial).not.toHaveBeenCalled();
  });

  it("throws when the bill cycle cannot be resolved", async () => {
    mockFindCycle.mockResolvedValue(null);

    await expect(
      aggregateBill(txStub, RUN, "BAN00000001"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockInsertTrial).not.toHaveBeenCalled();
  });
});

describe("deriveStubSubtotal (bm05-spec §Resolved — deterministic synthetic stub)", () => {
  it("is a pure, stable function of the billing account id (same input, same output)", () => {
    expect(deriveStubSubtotal("BAN00000001")).toBe(
      deriveStubSubtotal("BAN00000001"),
    );
  });

  it("differs across distinct accounts", () => {
    expect(deriveStubSubtotal("BAN00000001")).not.toBe(
      deriveStubSubtotal("BAN00000002"),
    );
  });

  it("always formats as a 2-decimal numeric string", () => {
    expect(deriveStubSubtotal("BAN00000042")).toMatch(/^\d+\.\d{2}$/);
  });
});
