import { beforeEach, describe, expect, it, vi } from "vitest";

// bm07-spec §Design/§Implementation §1. The Verification stage's app-computed
// outcome: always DONE (never fails/blocks the run); a single cheap backstop
// (unposted bill total `<= 0`) raises a SOFT finding recorded on the stage row.

vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: { findUnpostedTotalForVerification: vi.fn() },
}));

import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { verifyAccount } from "@/services/billing/verify";

const mockFindTotal = vi.mocked(
  customerBillRepository.findUnpostedTotalForVerification,
);

const txStub = {} as never;
const runStub = { billRunId: "BRN00000001" } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyAccount (bm07-spec §1)", () => {
  it("records a clean DONE when the account has no unposted bill", async () => {
    mockFindTotal.mockResolvedValue(null);

    const result = await verifyAccount(txStub, runStub, "BAN00000001");

    expect(result).toEqual({
      status: "DONE",
      errorClass: null,
      errorCode: null,
      errorDetail: null,
    });
  });

  it("records a clean DONE when the bill total is positive", async () => {
    mockFindTotal.mockResolvedValue({
      totalAmount: "116.10",
      nonPositive: false,
    });

    const result = await verifyAccount(txStub, runStub, "BAN00000001");

    expect(result.status).toBe("DONE");
    expect(result.errorClass).toBeNull();
  });

  it("raises a SOFT finding (still DONE) when the bill total is not positive", async () => {
    mockFindTotal.mockResolvedValue({
      totalAmount: "0.00",
      nonPositive: true,
    });

    const result = await verifyAccount(txStub, runStub, "BAN00000001");

    // The stage still completes — SOFT never blocks the run.
    expect(result.status).toBe("DONE");
    expect(result.errorClass).toBe("SOFT");
    expect(result.errorCode).toBe("NON_POSITIVE_TOTAL");
    expect(result.errorDetail).toContain("0.00");
  });

  it("reads the unposted total keyed on the run + account", async () => {
    mockFindTotal.mockResolvedValue(null);

    await verifyAccount(txStub, runStub, "BAN00000009");

    expect(mockFindTotal).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "BAN00000009",
    );
  });
});
