import { beforeEach, describe, expect, it, vi } from "vitest";

// bm05-spec §Implementation §5, extended by bm06 §Implementation §4 — the
// Customers & Bills tab's read: maps the joined repository rows onto
// `CustomerBillRow`, grouping each bill's tax items onto it. Derived live.

const txStub = {};
vi.mock("@/db/client", () => ({
  // Both reads run inside one repeatable-read snapshot (bm06 hardening) — the
  // mock just invokes the callback with a stub tx and returns its result.
  db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)) },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: { listForRun: vi.fn() },
}));
vi.mock("@/db/repositories/billing/customer-bill-tax-item.repository", () => ({
  customerBillTaxItemRepository: { listForRun: vi.fn() },
}));

import { db } from "@/db/client";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { customerBillTaxItemRepository } from "@/db/repositories/billing/customer-bill-tax-item.repository";
import { listAccountBills } from "@/services/billing/read/list-account-bills";

const mockTransaction = vi.mocked(db.transaction);
const mockListForRun = vi.mocked(customerBillRepository.listForRun);
const mockListTaxItems = vi.mocked(customerBillTaxItemRepository.listForRun);

beforeEach(() => {
  vi.clearAllMocks();
  mockListTaxItems.mockResolvedValue([]);
});

describe("listAccountBills (bm05-spec §5 / bm06-spec §4)", () => {
  it("maps each repository row onto a CustomerBillRow with its tax items", async () => {
    mockListForRun.mockResolvedValue([
      {
        customerBillId: "CBL00000001",
        billingAccountId: "BAN00000001",
        accountName: "Acme Sdn Bhd",
        currency: "MYR",
        category: "trial",
        subtotal: "107.50",
        taxTotal: "8.60",
        totalAmount: "116.10",
        paymentDueDate: "2026-08-31",
      },
    ]);
    mockListTaxItems.mockResolvedValue([
      {
        customerBillId: "CBL00000001",
        category: "GST",
        rate: "8.00",
        amount: "8.60",
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
        taxTotal: "8.60",
        totalAmount: "116.10",
        paymentDueDate: "2026-08-31",
        taxItems: [{ category: "GST", rate: "8.00", amount: "8.60" }],
      },
    ]);
  });

  it("attaches an empty tax-item array to a bill that has not been taxed yet", async () => {
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

    const [row] = await listAccountBills("BRN00000001");
    expect(row?.taxItems).toEqual([]);
  });

  it("groups tax items to their own bill only", async () => {
    mockListForRun.mockResolvedValue([
      {
        customerBillId: "CBL00000001",
        billingAccountId: "BAN00000001",
        accountName: "Acme",
        currency: "MYR",
        category: "trial",
        subtotal: "100.00",
        taxTotal: "8.00",
        totalAmount: "108.00",
        paymentDueDate: "2026-08-31",
      },
      {
        customerBillId: "CBL00000002",
        billingAccountId: "BAN00000002",
        accountName: "Globex",
        currency: "MYR",
        category: "trial",
        subtotal: "200.00",
        taxTotal: "16.00",
        totalAmount: "216.00",
        paymentDueDate: "2026-08-31",
      },
    ]);
    mockListTaxItems.mockResolvedValue([
      {
        customerBillId: "CBL00000001",
        category: "GST",
        rate: "8.00",
        amount: "8.00",
      },
      {
        customerBillId: "CBL00000002",
        category: "GST",
        rate: "8.00",
        amount: "16.00",
      },
    ]);

    const rows = await listAccountBills("BRN00000001");

    expect(rows[0]?.taxItems).toEqual([
      { category: "GST", rate: "8.00", amount: "8.00" },
    ]);
    expect(rows[1]?.taxItems).toEqual([
      { category: "GST", rate: "8.00", amount: "16.00" },
    ]);
  });

  it("returns an empty array when the run has no draft bills yet", async () => {
    mockListForRun.mockResolvedValue([]);

    expect(await listAccountBills("BRN00000001")).toEqual([]);
  });

  it("reads bills and tax items from one shared snapshot (same tx handle)", async () => {
    // Regression for the read-skew hardening: both repository reads must run on
    // the same transaction handle so they see one consistent snapshot. (The
    // real concurrent-commit assertion is a DB-gated integration test — not
    // runnable here, no local Postgres.)
    mockListForRun.mockResolvedValue([]);

    await listAccountBills("BRN00000001");

    const billTx = mockListForRun.mock.calls[0]?.[0];
    const taxTx = mockListTaxItems.mock.calls[0]?.[0];
    expect(billTx).toBe(taxTx);

    // ...and that snapshot is opened `repeatable read`, `read only` — the two
    // isolation guarantees that make the shared handle a consistent, side-effect-
    // free read (bm06 read-skew hardening).
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  });
});
