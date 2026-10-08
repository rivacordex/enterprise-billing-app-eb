import { beforeEach, describe, expect, it, vi } from "vitest";

// bm47-spec §Implementation §6, test plan row 4 ("updated"). Mocks
// `buildInvoiceHtml` (the binder entry point, now the sole DB/bind/compile
// surface) and Playwright, so the orchestration this file still owns — one
// launch per render, bounded by the T9 semaphore, the browser always closes
// in `finally`, and the new `page.pdf` options — is provable without a real
// database or browser.

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

vi.mock("@/services/billing/render-invoice-template", () => ({
  buildInvoiceHtml: vi.fn(),
}));

import { chromium } from "playwright";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import {
  renderDraftInvoice,
  renderFinalInvoice,
} from "@/services/billing/render-invoice";

const mockLaunch = vi.mocked(chromium.launch);
const mockBuildInvoiceHtml = vi.mocked(buildInvoiceHtml);

const PAGE_SETUP = {
  format: "A4" as const,
  orientation: "portrait" as const,
  margin: { top: "13mm", bottom: "16mm", left: "14mm", right: "14mm" },
  displayHeaderFooter: true,
  printBackground: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  launchDelaysMs.length = 0;
  activeLaunches = 0;
  maxActiveLaunches = 0;
  mockBuildInvoiceHtml.mockResolvedValue({
    html: "<html>stub</html>",
    footerHtml: "<div>footer</div>",
    pageSetup: PAGE_SETUP,
  });
});

describe("renderDraftInvoice", () => {
  it("builds the HTML via the binder entry point in draft mode", async () => {
    await renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" });

    expect(mockBuildInvoiceHtml).toHaveBeenCalledWith({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "draft",
    });
  });

  it("renders via Chromium and returns the PDF buffer", async () => {
    const pdf = await renderDraftInvoice({
      runId: "BRN00000042",
      banId: "BAN00000001",
    });

    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(pdf.toString()).toBe("PDF-BYTES");
  });

  it("calls page.pdf with the layout's page setup and the footer/header templates (D9)", async () => {
    const pdfMock = vi.fn().mockResolvedValue(Buffer.from("PDF-BYTES"));
    mockLaunch.mockResolvedValueOnce({
      newPage: vi.fn().mockResolvedValue({
        setContent: vi.fn().mockResolvedValue(undefined),
        pdf: pdfMock,
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    await renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" });

    expect(pdfMock).toHaveBeenCalledWith({
      format: "A4",
      landscape: false,
      printBackground: true,
      margin: PAGE_SETUP.margin,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: "<div>footer</div>",
    });
  });

  it("propagates a binder error without launching Chromium", async () => {
    mockBuildInvoiceHtml.mockRejectedValueOnce(new Error("reconciliation failed"));

    await expect(
      renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" }),
    ).rejects.toThrow("reconciliation failed");
    expect(mockLaunch).not.toHaveBeenCalled();
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

describe("renderFinalInvoice", () => {
  it("builds the HTML via the binder entry point in final mode, passing invoiceNo", async () => {
    await renderFinalInvoice({
      runId: "BRN00000042",
      banId: "BAN00000001",
      invoiceNo: "INV00000001",
    });

    expect(mockBuildInvoiceHtml).toHaveBeenCalledWith({
      runId: "BRN00000042",
      banId: "BAN00000001",
      mode: "final",
      invoiceNo: "INV00000001",
    });
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
