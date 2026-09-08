import { beforeEach, describe, expect, it, vi } from "vitest";

// bm18-spec §Implementation §2 / Verification checklist / Phase-2 review
// fold T9. Mocks the DB, the pure template builder, and Playwright so the
// orchestration (read snapshot → build HTML → launch-per-render, bounded by
// the T9 semaphore → always close in `finally`) is provable without a real
// database or browser — same DB-free-unit-suite convention as
// list-account-bills.test.ts.

const txStub = {};
const transactionOptions: unknown[] = [];
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown, opts: unknown) => {
      transactionOptions.push(opts);
      return cb(txStub);
    }),
  },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: { findForAccount: vi.fn() },
}));
vi.mock("@/db/repositories/billing/customer-bill-tax-item.repository", () => ({
  customerBillTaxItemRepository: { listForBill: vi.fn() },
}));
vi.mock("@/db/repositories/billing/rated-lines.repository", () => ({
  ratedLinesRepository: { listClaimedForAccount: vi.fn() },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: { findDetailById: vi.fn() },
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppLocale: vi.fn().mockResolvedValue("en-MY"),
}));
vi.mock("@/services/billing/render-invoice-template", () => ({
  buildDraftInvoiceHtml: vi.fn().mockReturnValue("<html>stub</html>"),
  buildFinalInvoiceHtml: vi.fn().mockReturnValue("<html>final-stub</html>"),
}));

let activeLaunches = 0;
let maxActiveLaunches = 0;
const launchDelaysMs: number[] = [];
vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => {
      activeLaunches++;
      maxActiveLaunches = Math.max(maxActiveLaunches, activeLaunches);
      const delay = launchDelaysMs.shift() ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return {
        newPage: vi.fn().mockResolvedValue({
          setContent: vi.fn().mockResolvedValue(undefined),
          pdf: vi.fn().mockResolvedValue(Buffer.from("PDF-BYTES")),
        }),
        close: vi.fn(async () => {
          activeLaunches--;
        }),
      };
    }),
  },
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { customerBillTaxItemRepository } from "@/db/repositories/billing/customer-bill-tax-item.repository";
import { ratedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";
import { chromium } from "playwright";
import {
  DraftInvoiceNotFoundError,
  FinalInvoiceNotFoundError,
  renderDraftInvoice,
  renderFinalInvoice,
} from "@/services/billing/render-invoice";
import { buildFinalInvoiceHtml } from "@/services/billing/render-invoice-template";
import { db } from "@/db/client";

const mockFindForAccount = vi.mocked(customerBillRepository.findForAccount);
const mockListForBill = vi.mocked(customerBillTaxItemRepository.listForBill);
const mockListClaimed = vi.mocked(ratedLinesRepository.listClaimedForAccount);
const mockFindDetailById = vi.mocked(billRunRepository.findDetailById);
const mockLaunch = vi.mocked(chromium.launch);
const mockBuildFinalInvoiceHtml = vi.mocked(buildFinalInvoiceHtml);

const BILL = {
  customerBillId: "CBL00000001",
  periodPartition: "2026-08-01",
  billingAccountId: "BAN00000001",
  accountName: "Acme Communications",
  currency: "MYR",
  category: "trial",
  billingPeriodStart: "2026-08-01",
  billingPeriodEnd: "2026-08-31",
  subtotal: "100.00",
  taxTotal: "8.00",
  totalAmount: "108.00",
  paymentDueDate: "2026-09-15",
  refInvDocumentId: null,
};

const RUN = {
  billRunId: "BRN00000042",
  cycleName: "Enterprise Monthly",
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  scheduledRunDate: "2026-09-01",
  status: "PROCESSED",
  lastProgressAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  transactionOptions.length = 0;
  launchDelaysMs.length = 0;
  activeLaunches = 0;
  maxActiveLaunches = 0;
  mockFindForAccount.mockResolvedValue(BILL);
  mockListForBill.mockResolvedValue([]);
  mockListClaimed.mockResolvedValue([]);
  mockFindDetailById.mockResolvedValue(RUN);
  mockBuildFinalInvoiceHtml.mockReturnValue("<html>final-stub</html>");
});

describe("renderDraftInvoice — not-found (spec §2 step 1)", () => {
  it("throws DraftInvoiceNotFoundError when no bill exists for the account", async () => {
    mockFindForAccount.mockResolvedValue(null);

    await expect(
      renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" }),
    ).rejects.toBeInstanceOf(DraftInvoiceNotFoundError);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("throws DraftInvoiceNotFoundError when the run detail row is missing", async () => {
    mockFindDetailById.mockResolvedValue(null);

    await expect(
      renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" }),
    ).rejects.toBeInstanceOf(DraftInvoiceNotFoundError);
    expect(mockLaunch).not.toHaveBeenCalled();
  });
});

describe("renderDraftInvoice — read snapshot", () => {
  it("reads inside one repeatable-read, read-only transaction (no straddled commit)", async () => {
    await renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" });

    expect(transactionOptions).toEqual([
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ]);
  });
});

describe("renderDraftInvoice — Chromium render (D18/D19)", () => {
  it("renders via Chromium and returns the PDF buffer", async () => {
    const pdf = await renderDraftInvoice({
      runId: "BRN00000042",
      banId: "BAN00000001",
    });

    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(pdf.toString()).toBe("PDF-BYTES");
  });

  it("closes the browser even when rendering fails (no leaked processes)", async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    mockLaunch.mockResolvedValueOnce({
      newPage: vi.fn().mockResolvedValue({
        setContent: vi.fn().mockResolvedValue(undefined),
        pdf: vi.fn().mockRejectedValue(new Error("chromium crashed")),
      }),
      close: closeMock,
    } as never);

    await expect(
      renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" }),
    ).rejects.toThrow("chromium crashed");

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("never launches more than the T9 concurrency cap at once; excess requests queue", async () => {
    launchDelaysMs.push(20, 20, 20, 20);

    await Promise.all([
      renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" }),
      renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" }),
      renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" }),
      renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" }),
    ]);

    expect(mockLaunch).toHaveBeenCalledTimes(4);
    expect(maxActiveLaunches).toBeLessThanOrEqual(2);
  });
});

// bm19-spec §Design "Final render = draft renderer, no watermark, real
// number" / §Implementation §3.
describe("renderFinalInvoice — not-found (bm19-spec §Implementation §3)", () => {
  it("throws FinalInvoiceNotFoundError when no bill exists for the account", async () => {
    mockFindForAccount.mockResolvedValue(null);

    await expect(
      renderFinalInvoice({
        runId: "BRN00000042",
        banId: "BAN00000001",
        invoiceNo: "INV00000001",
      }),
    ).rejects.toBeInstanceOf(FinalInvoiceNotFoundError);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("throws FinalInvoiceNotFoundError when the run detail row is missing", async () => {
    mockFindDetailById.mockResolvedValue(null);

    await expect(
      renderFinalInvoice({
        runId: "BRN00000042",
        banId: "BAN00000001",
        invoiceNo: "INV00000001",
      }),
    ).rejects.toBeInstanceOf(FinalInvoiceNotFoundError);
    expect(mockLaunch).not.toHaveBeenCalled();
  });
});

describe("renderFinalInvoice — read + render (D10/D19, Phase-2 review fold T9)", () => {
  it("reads via a plain (non-transactional) query — no repeatable-read snapshot needed once posted", async () => {
    await renderFinalInvoice({
      runId: "BRN00000042",
      banId: "BAN00000001",
      invoiceNo: "INV00000001",
    });

    expect(mockFindForAccount).toHaveBeenCalledWith(
      db,
      "BRN00000042",
      "BAN00000001",
    );
  });

  it("builds the final HTML with the real invoice number, no watermark params", async () => {
    await renderFinalInvoice({
      runId: "BRN00000042",
      banId: "BAN00000001",
      invoiceNo: "INV00000001",
    });

    expect(mockBuildFinalInvoiceHtml).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceNumber: "INV00000001" }),
    );
  });

  it("renders via Chromium and returns the PDF buffer", async () => {
    const pdf = await renderFinalInvoice({
      runId: "BRN00000042",
      banId: "BAN00000001",
      invoiceNo: "INV00000001",
    });

    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(pdf.toString()).toBe("PDF-BYTES");
  });

  it("closes the browser even when rendering fails (no leaked processes)", async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    mockLaunch.mockResolvedValueOnce({
      newPage: vi.fn().mockResolvedValue({
        setContent: vi.fn().mockResolvedValue(undefined),
        pdf: vi.fn().mockRejectedValue(new Error("chromium crashed")),
      }),
      close: closeMock,
    } as never);

    await expect(
      renderFinalInvoice({
        runId: "BRN00000042",
        banId: "BAN00000001",
        invoiceNo: "INV00000001",
      }),
    ).rejects.toThrow("chromium crashed");

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  // T9's fold explicitly extends the SAME concurrency guard to final
  // rendering — proven here by having a draft render and a final render
  // share the cap.
  it("shares the T9 concurrency cap with draft rendering — excess requests queue across both", async () => {
    launchDelaysMs.push(20, 20, 20, 20);

    await Promise.all([
      renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" }),
      renderFinalInvoice({
        runId: "BRN00000042",
        banId: "BAN00000001",
        invoiceNo: "INV00000001",
      }),
      renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" }),
      renderFinalInvoice({
        runId: "BRN00000042",
        banId: "BAN00000001",
        invoiceNo: "INV00000002",
      }),
    ]);

    expect(mockLaunch).toHaveBeenCalledTimes(4);
    expect(maxActiveLaunches).toBeLessThanOrEqual(2);
  });
});
