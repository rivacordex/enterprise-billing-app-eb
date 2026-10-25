import { beforeEach, describe, expect, it, vi } from "vitest";

// bm47-spec §Implementation §6, test plan row 4 ("updated"); bm75-spec §3.
// Mocks `buildInvoiceHtml` (the binder entry point, now the sole
// DB/bind/compile surface) and Playwright, so the orchestration this file
// still owns — one launch per render, bounded by the T9 semaphore, the browser
// always closes in `finally`, the `page.pdf` options, and (bm75) the hardened
// context with its request route — is provable without a real database or
// browser. The mock follows the context chain: `chromium.launch` →
// `{ newContext, close }`, `newContext` → `{ newPage }`, `newPage` →
// `{ route, setContent, pdf }`; `route` captures its handler and
// `setContent` replays `requestUrls` through it, as Chromium would.

interface FakeRoute {
  request: () => { url: () => string };
  continue: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}
type RouteHandler = (route: FakeRoute) => unknown;

let activeLaunches = 0;
let maxActiveLaunches = 0;
const launchDelaysMs: number[] = [];
// URLs the page "requests" during setContent, and the fake routes they made.
let requestUrls: string[] = [];
let routes: FakeRoute[] = [];

function fakePage(pdf: ReturnType<typeof vi.fn>) {
  let handler: RouteHandler | undefined;
  return {
    route: vi.fn(async (_pattern: string, h: RouteHandler) => {
      handler = h;
    }),
    setContent: vi.fn(async () => {
      for (const url of requestUrls) {
        const route: FakeRoute = {
          request: () => ({ url: () => url }),
          continue: vi.fn().mockResolvedValue(undefined),
          abort: vi.fn().mockResolvedValue(undefined),
        };
        routes.push(route);
        await handler?.(route);
      }
    }),
    pdf,
  };
}

function fakeBrowser(
  page: ReturnType<typeof fakePage>,
  close: ReturnType<typeof vi.fn>,
) {
  return {
    newContext: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue(page),
    }),
    close,
  };
}

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => {
      activeLaunches++;
      maxActiveLaunches = Math.max(maxActiveLaunches, activeLaunches);
      const delay = launchDelaysMs.shift() ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return fakeBrowser(
        fakePage(vi.fn().mockResolvedValue(Buffer.from("PDF-BYTES"))),
        vi.fn(async () => {
          activeLaunches--;
        }),
      );
    }),
  },
}));

vi.mock("@/services/billing/render-invoice-template", () => ({
  buildInvoiceHtml: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { chromium } from "playwright";
import { logger } from "@/lib/logger";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import {
  renderDraftInvoice,
  renderFinalInvoice,
} from "@/services/billing/render-invoice";
import type { ResolvedTemplate } from "@/types/billing";

const mockLaunch = vi.mocked(chromium.launch);
const mockBuildInvoiceHtml = vi.mocked(buildInvoiceHtml);
const mockWarn = vi.mocked(logger.warn);

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
  requestUrls = [];
  routes = [];
  mockBuildInvoiceHtml.mockResolvedValue({
    html: "<html>stub</html>",
    footerHtml: "<div>footer</div>",
    pageSetup: PAGE_SETUP,
    // bm75 — the version ids feed the blocked-fetch log line only.
    resolved: {
      layout: { billTemplateVersionId: "BTV00000001" },
      generated: { billTemplateVersionId: "BTV00000002" },
    } as ResolvedTemplate,
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
    mockLaunch.mockResolvedValueOnce(
      fakeBrowser(
        fakePage(pdfMock),
        vi.fn().mockResolvedValue(undefined),
      ) as never,
    );

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
    mockBuildInvoiceHtml.mockRejectedValueOnce(
      new Error("reconciliation failed"),
    );

    await expect(
      renderDraftInvoice({ runId: "BRN00000042", banId: "BAN00000001" }),
    ).rejects.toThrow("reconciliation failed");
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("closes the browser even when rendering fails (no leaked processes)", async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    mockLaunch.mockResolvedValueOnce(
      fakeBrowser(
        fakePage(vi.fn().mockRejectedValue(new Error("chromium crashed"))),
        closeMock,
      ) as never,
    );

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
    mockLaunch.mockResolvedValueOnce(
      fakeBrowser(
        fakePage(vi.fn().mockRejectedValue(new Error("chromium crashed"))),
        closeMock,
      ) as never,
    );

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

describe("bm75 — the hardened context (Inv #64)", () => {
  async function renderCapturingBrowser() {
    const page = fakePage(vi.fn().mockResolvedValue(Buffer.from("PDF-BYTES")));
    const browser = fakeBrowser(page, vi.fn().mockResolvedValue(undefined));
    mockLaunch.mockResolvedValueOnce(browser as never);
    const pdf = await renderDraftInvoice({
      runId: "BRN00000042",
      banId: "BAN00000001",
    });
    return { pdf, page, browser };
  }

  it("creates one context per render with JavaScript off and offline, and routes every request", async () => {
    const { page, browser } = await renderCapturingBrowser();

    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(browser.newContext).toHaveBeenCalledWith({
      javaScriptEnabled: false,
      offline: true,
    });
    expect(page.route).toHaveBeenCalledWith("**/*", expect.any(Function));
  });

  it("aborts a network URL, still returns the PDF, and logs the blocked fetch once", async () => {
    requestUrls = ["https://x.example/a.png"];

    const { pdf } = await renderCapturingBrowser();

    expect(routes).toHaveLength(1);
    expect(routes[0]!.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(routes[0]!.continue).not.toHaveBeenCalled();
    expect(pdf.toString()).toBe("PDF-BYTES");
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith("INVOICE_RENDER_BLOCKED_FETCH", {
      layoutVersionId: "BTV00000001",
      generatedVersionId: "BTV00000002",
      count: 1,
      urls: ["https://x.example/a.png"],
    });
  });

  it("continues a data: URL and logs nothing", async () => {
    requestUrls = ["data:image/png;base64,iVBORw0KGgo="];

    await renderCapturingBrowser();

    expect(routes[0]!.continue).toHaveBeenCalledTimes(1);
    expect(routes[0]!.abort).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("logs the full count but at most 5 URLs", async () => {
    requestUrls = Array.from(
      { length: 7 },
      (_, i) => `https://x.example/${i}.png`,
    );

    await renderCapturingBrowser();

    expect(mockWarn).toHaveBeenCalledTimes(1);
    const fields = mockWarn.mock.calls[0]![1] as {
      count: number;
      urls: string[];
    };
    expect(fields.count).toBe(7);
    expect(fields.urls).toEqual(requestUrls.slice(0, 5));
  });

  it("a final render logs a blocked fetch with the same ids and never throws", async () => {
    requestUrls = ["http://127.0.0.1:9/f.woff2"];

    const pdf = await renderFinalInvoice({
      runId: "BRN00000042",
      banId: "BAN00000001",
      invoiceNo: "INV00000001",
    });

    expect(pdf.toString()).toBe("PDF-BYTES");
    expect(mockWarn).toHaveBeenCalledWith(
      "INVOICE_RENDER_BLOCKED_FETCH",
      expect.objectContaining({
        layoutVersionId: "BTV00000001",
        generatedVersionId: "BTV00000002",
        count: 1,
      }),
    );
  });
});
