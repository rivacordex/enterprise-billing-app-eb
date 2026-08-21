import { beforeEach, describe, expect, it, vi } from "vitest";

// bm06-spec §Design/§Implementation §3. taxBill resolves the account's unposted
// trial bill, stamps the run's tax-rate version once, rerun-safely replaces the
// bill's tax items (tax computed in SQL numeric), and recomputes the totals.

vi.mock("@/lib/config", () => ({
  billRunTaxConfig: { rate: 8, version: "SST-2026", category: "SST" },
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
      "SST-2026",
    );
    expect(mockReplaceForBill).toHaveBeenCalledWith(txStub, {
      customerBillId: "CBL00000001",
      periodPartition: "2026-07-01",
      category: "SST",
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

  it("is a no-op when the account has no unposted bill (nothing to tax)", async () => {
    mockFindUnpostedBill.mockResolvedValue(null);

    await taxBill(txStub, RUN, "BAN00000009");

    expect(mockStampVersion).not.toHaveBeenCalled();
    expect(mockReplaceForBill).not.toHaveBeenCalled();
    expect(mockRecomputeTotals).not.toHaveBeenCalled();
  });

  it("never re-taxes a posted bill — the finalization latch lives in findUnpostedBill", async () => {
    // A posted bill is filtered out by `findUnpostedBill` (ref_inv_document_id
    // IS NULL), so it surfaces here as `null` → the no-op path above.
    mockFindUnpostedBill.mockResolvedValue(null);

    await taxBill(txStub, RUN, "BAN00000001");

    expect(mockReplaceForBill).not.toHaveBeenCalled();
  });

  it("passes the configured rate/category through to the SQL write", async () => {
    await taxBill(txStub, RUN, "BAN00000001");

    const [, args] = mockReplaceForBill.mock.calls[0] as [
      unknown,
      { category: string; rate: number },
    ];
    expect(args.category).toBe("SST");
    expect(args.rate).toBe(8);
  });
});
