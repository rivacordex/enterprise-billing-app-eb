import { beforeEach, describe, expect, it, vi } from "vitest";

// bm05-spec §Implementation §5 — the Customers & Bills tab's read: maps the
// joined repository rows onto `CustomerBillRow`, derived live.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: { listForRun: vi.fn() },
}));

import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { listAccountBills } from "@/services/billing/read/list-account-bills";

const mockListForRun = vi.mocked(customerBillRepository.listForRun);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listAccountBills (bm05-spec §5)", () => {
  it("maps each repository row onto a CustomerBillRow", async () => {
    mockListForRun.mockResolvedValue([
      {
        customerBillId: "CBL00000001",
        billingAccountId: "BAN00000001",
        accountName: "Acme Sdn Bhd",
        currency: "MYR",
        category: "trial",
        subtotal: "107.50",
        taxTotal: "0.00",
        totalAmount: "107.50",
        paymentDueDate: "2026-08-31",
      },
    ]);

    const rows = await listAccountBills("BRN00000001");

    expect(rows).toEqual([
      {
        customerBillId: "CBL00000001",
        billingAccountId: "BAN00000001",
        accountName: "Acme Sdn Bhd",
        category: "trial",
        currency: "MYR",
        subtotal: "107.50",
        taxTotal: "0.00",
        totalAmount: "107.50",
        paymentDueDate: "2026-08-31",
      },
    ]);
  });

  it("returns an empty array when the run has no draft bills yet", async () => {
    mockListForRun.mockResolvedValue([]);

    expect(await listAccountBills("BRN00000001")).toEqual([]);
  });
});
