import { beforeEach, describe, expect, it, vi } from "vitest";

// bm06-spec §Design/§Implementation §3. taxBill resolves the account's unposted
// trial bill, stamps the run's tax-rate version once, rerun-safely replaces the
// bill's tax items (tax computed in SQL numeric), and recomputes the totals.

vi.mock("@/lib/config", () => ({
  billRunTaxConfig: { rate: 8, version: "GST-2026", category: "GST" },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: { stampTaxRateVersion: vi.fn() },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: {
    findUnpostedBill: vi.fn(),
    recomputeTotals: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/customer-bill-tax-item.repository", () => ({
  customerBillTaxItemRepository: { replaceForBill: vi.fn() },
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { customerBillTaxItemRepository } from "@/db/repositories/billing/customer-bill-tax-item.repository";
import { taxBill } from "@/services/billing/taxation";

const mockFindUnpostedBill = vi.mocked(customerBillRepository.findUnpostedBill);
const mockRecomputeTotals = vi.mocked(customerBillRepository.recomputeTotals);
const mockStampVersion = vi.mocked(billRunRepository.stampTaxRateVersion);
const mockReplaceForBill = vi.mocked(
  customerBillTaxItemRepository.replaceForBill,
);

const txStub = {} as never;
const RUN = { billRunId: "BRN00000001" };

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnpostedBill.mockResolvedValue({
    customerBillId: "CBL00000001",
    periodPartition: "2026-07-01",
    subtotal: "107.50",
  });
  mockStampVersion.mockResolvedValue(undefined);
  mockReplaceForBill.mockResolvedValue(undefined);
  mockRecomputeTotals.mockResolvedValue(undefined);
});

describe("taxBill (bm06-spec §3)", () => {
  it("stamps the run tax-rate version, replaces tax items, then recomputes totals — in order", async () => {
    await taxBill(txStub, RUN, "BAN00000001");

    expect(mockStampVersion).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "GST-2026",
    );
    expect(mockReplaceForBill).toHaveBeenCalledWith(txStub, {
      customerBillId: "CBL00000001",
      periodPartition: "2026-07-01",
      category: "GST",
      rate: 8,
    });
    expect(mockRecomputeTotals).toHaveBeenCalledWith(
      txStub,
      "CBL00000001",
      "2026-07-01",
    );

    const replaceOrder = mockReplaceForBill.mock.invocationCallOrder[0];
    const recomputeOrder = mockRecomputeTotals.mock.invocationCallOrder[0];
    expect(replaceOrder).toBeLessThan(recomputeOrder as number);
  });

  it("rejects (rolls back) when the account has no unposted bill — out-of-order before Aggregation", async () => {
    // Aggregation hasn't produced the bill yet: findUnpostedBill returns null.
    // taxBill must throw (rolling back the ingest txn so the taxation stage row
    // is never committed), NOT silently record a zero-tax completion.
    mockFindUnpostedBill.mockResolvedValue(null);

    await expect(taxBill(txStub, RUN, "BAN00000009")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(mockStampVersion).not.toHaveBeenCalled();
    expect(mockReplaceForBill).not.toHaveBeenCalled();
    expect(mockRecomputeTotals).not.toHaveBeenCalled();
  });

  it("sequence: taxation before Aggregation rejects, then succeeds once the bill exists", async () => {
    // First signal — no bill yet → reject.
    mockFindUnpostedBill.mockResolvedValueOnce(null);
    await expect(taxBill(txStub, RUN, "BAN00000001")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(mockReplaceForBill).not.toHaveBeenCalled();

    // Retry after Aggregation created the bill → taxes it.
    mockFindUnpostedBill.mockResolvedValueOnce({
      customerBillId: "CBL00000001",
      periodPartition: "2026-07-01",
      subtotal: "107.50",
    });
    await taxBill(txStub, RUN, "BAN00000001");
    expect(mockReplaceForBill).toHaveBeenCalledTimes(1);
    expect(mockRecomputeTotals).toHaveBeenCalledTimes(1);
  });

  it("passes the configured rate/category through to the SQL write", async () => {
    await taxBill(txStub, RUN, "BAN00000001");

    const [, args] = mockReplaceForBill.mock.calls[0] as [
      unknown,
      { category: string; rate: number },
    ];
    expect(args.category).toBe("GST");
    expect(args.rate).toBe(8);
  });
});
