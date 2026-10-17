import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";

// bm53 — the seeded default comes through the real verified loader; the blob
// transport serves the committed repo bytes (tests/helpers/seeded-invoice-template).
vi.mock(
  "@/services/billing/blob-store",
  async () =>
    (await import("@/tests/helpers/seeded-invoice-template"))
      .repoBlobStoreModule,
);

import { bind } from "@/services/billing/invoice-template/bind";
import { executeInvoiceTemplate } from "@/services/billing/invoice-template/compile";
import { loadGenerated } from "@/services/billing/invoice-template/load";
import {
  SEEDED_FOOTNOTE,
  SEEDED_GENERATED_ROW,
  SEEDED_TEMPLATE_STAMP,
} from "@/tests/helpers/seeded-invoice-template";
import type { InvoiceRenderInput } from "@/types/billing";
import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import type {
  CapacityDetailGroupRaw,
  CapacityDetailRowRaw,
} from "@/db/repositories/billing/rated-lines.repository";
import { layoutPageSetupSchema } from "@/validation/billing/layout-page-setup.schema";

// bm49 — a REAL Chromium render (not the mocked `render-invoice.service.test.ts`)
// that drives the actually-seeded generated template through `bind` → Handlebars
// → Chromium PDF; since bm71 it exercises the type → State-District detail
// pages end to end, on a ~900-polygon bill. The
// pipeline needs no DB (the verified loader is served the repo `.hbs`), so this is
// gated behind RUN_CHROMIUM_E2E=1 to keep it out of the fast unit run:
//
//   RUN_CHROMIUM_E2E=1 node --env-file=.env node_modules/vitest/vitest.mjs run \
//     tests/services/billing/invoice-render-chromium.e2e.test.ts
//
// It uses the EXACT `page.pdf(...)` options `render-invoice.ts` uses (A4 page
// setup from the layout manifest, `displayHeaderFooter` + the `footer.hbs`
// footer for "Page X of Y").
const run = process.env.RUN_CHROMIUM_E2E === "1";

const TZ = "Asia/Kuala_Lumpur";

// bm71 — a consistent capacity detail read (rows + GROUPING SETS-shaped
// groups) for one type of service, with JS sums: this is fixture scaffolding,
// the production Sub Total math is SQL's. Every polygon is 1 Mbps × RM100.
const OFFERING = "POF00000020";

function buildDetail(regions: number, rowsPer: number) {
  const rows: CapacityDetailRowRaw[] = [];
  const groups: CapacityDetailGroupRaw[] = [];
  const money = (n: number) => `${n}.00`;
  for (let r = 0; r < regions; r++) {
    const regionLabel = `STATE-${String(r + 1).padStart(2, "0")} - DISTRICT-${r + 1}`;
    for (let i = 0; i < rowsPer; i++) {
      rows.push({
        udrId: `UDR${String(r * rowsPer + i).padStart(8, "0")}`,
        offeringId: OFFERING,
        label: "RAN Target Capacity",
        regionLabel,
        polygonStartDate: "2025-03-01",
        polygonId: `PCU-${r + 1}-${String(i + 1).padStart(4, "0")}`,
        resourceOk: true,
        capacityMbps: "1.000000",
        ratePerMbps: "100.00",
        amount: "100.00",
      });
    }
    groups.push({
      offeringId: OFFERING,
      regionLabel,
      gRegion: 0,
      amount: money(rowsPer * 100),
    });
  }
  const grandAmount = money(regions * rowsPer * 100);
  groups.push({
    offeringId: OFFERING,
    regionLabel: null,
    gRegion: 1,
    amount: grandAmount,
  });
  return { rows, groups, grandAmount };
}

function rawInput(
  detail: ReturnType<typeof buildDetail>,
): RawInvoiceRenderInput {
  return {
    bill: {
      customerBillId: "CBL00000001",
      periodPartition: "2026-06-01",
      billingAccountId: "BAN00000001",
      currency: "MYR",
      billingPeriodStart: "2026-06-01",
      billingPeriodEnd: "2026-06-30",
      paymentDueDate: "2026-07-15",
      // bm70 — the `ci` 2,000 Mbps capacity anchor: gross 200,000 −
      // discount 50,000 = net 150,000.
      subtotal: "150000.00",
      taxTotal: "0.00",
      totalAmount: "150000.00",
      linesNetSum: "150000.00",
      grossTotal: "200000.00",
      discountTotal: "50000.00",
      otherChargesSubTotal: "0.00",
      adjustments: "0.00",
      summaryBlocksSum: "150000.00",
      // bm72 — Total Amount = Σ Utilised.
      utilisedTotal: "150000.00",
    },
    run: { billRunId: "BRN00000042", cycleName: "Enterprise Monthly" },
    lines: [],
    serviceTypes: [
      {
        offeringId: OFFERING,
        label: "RAN Target Capacity",
        utilised: "150000.00",
        unutilised: "0.00",
        total: "150000.00",
        // The fixture's own detail total (bm71 reconciliation).
        ratedTotal: detail.grandAmount,
        missingRated: false,
        negativeUtilised: false,
      },
    ],
    otherCharges: [],
    taxItems: [],
    capacityDetail: {
      overLimit: false,
      rows: detail.rows,
      groups: detail.groups,
    },
    document: null,
    customer: {
      recipientName: "Aisha Rahman",
      name: "Acme Communications Sdn Bhd",
      tradingName: null,
      registrationNumber: null,
      taxId: null,
      email: null,
      phone: null,
      address: null,
    },
  };
}

async function loadPageSetup() {
  const raw = await readFile(
    path.join(
      process.cwd(),
      "db/seeds/invoice-templates/INVTPL-STD-A4/v1/manifest.json",
    ),
    "utf-8",
  );
  return layoutPageSetupSchema.parse(
    (JSON.parse(raw) as { pageSetup: unknown }).pageSetup,
  );
}

async function renderPdf(
  browser: Browser,
  html: string,
  footerHtml: string,
  pageSetup: Awaited<ReturnType<typeof loadPageSetup>>,
  requests: string[] = [],
): Promise<Buffer> {
  const page = await browser.newPage();
  page.on("request", (req) => {
    if (!req.url().startsWith("data:")) requests.push(req.url());
  });
  try {
    await page.setContent(html, { waitUntil: "networkidle" });
    return await page.pdf({
      format: pageSetup.format,
      landscape: pageSetup.orientation === "landscape",
      printBackground: pageSetup.printBackground,
      margin: pageSetup.margin,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: footerHtml,
    });
  } finally {
    await page.close();
  }
}

// Number of pages the laid-out content spans under print media — a
// dependency-free multi-page check (no PDF parser). `scrollHeight` is the
// continuous layout height; the paginated page count is
// `ceil(height / printable-page-height)`. 1mm ≈ 96/25.4 CSS px at 96dpi; A4 is
// 297mm tall portrait / 210mm landscape, minus the top+bottom print margins.
async function printPageCount(
  browser: Browser,
  html: string,
  pageSetup: Awaited<ReturnType<typeof loadPageSetup>>,
): Promise<number> {
  const PX_PER_MM = 96 / 25.4;
  const pageHeightMm = pageSetup.orientation === "landscape" ? 210 : 297;
  const printablePx =
    (pageHeightMm -
      parseFloat(pageSetup.margin.top) -
      parseFloat(pageSetup.margin.bottom)) *
    PX_PER_MM;
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.emulateMedia({ media: "print" });
    const heightPx = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    return Math.ceil(heightPx / printablePx);
  } finally {
    await page.close();
  }
}

async function loadSeededDefault(): Promise<{
  render: (input: InvoiceRenderInput) => string;
  renderFooter: (input: InvoiceRenderInput) => string;
}> {
  const { invoice, footer } = await loadGenerated(SEEDED_GENERATED_ROW);
  return {
    render: (input) => executeInvoiceTemplate(invoice, input),
    renderFooter: (input) => executeInvoiceTemplate(footer, input),
  };
}

describe.skipIf(!run)(
  "bm49/bm71 invoice render — real Chromium (RUN_CHROMIUM_E2E=1)",
  () => {
    let browser: Browser;

    beforeAll(async () => {
      browser = await chromium.launch();
    }, 60_000);

    afterAll(async () => {
      if (browser) await browser.close();
    });

    it("renders a valid multi-page PDF for a ~900-polygon detail (draft) with no network request, with the Page X of Y footer wired", async () => {
      const { render, renderFooter } = await loadSeededDefault();
      const pageSetup = await loadPageSetup();

      // 9 State-District groups × 100 polygons = 900 rows → many A4 pages at
      // the §10d 8pt table size.
      const big = bind(rawInput(buildDetail(9, 100)), {
        isDraft: true,
        locale: "en-MY",
        timezone: TZ,
        template: SEEDED_TEMPLATE_STAMP,
        profile: null,
        footnote: [...SEEDED_FOOTNOTE],
      });
      const html = render(big);
      const footer = renderFooter(big);

      // The footer Chromium repeats per page carries the page-number spans.
      expect(footer).toContain('class="pageNumber"');
      expect(footer).toContain('class="totalPages"');
      // thead repeats across page breaks; watermark is a fixed layer (not clipped).
      expect(html.match(/<td class="mono">PCU-/g)).toHaveLength(900);
      expect(footer).toContain('<span style="text-align: right;">Page');
      expect(html).toMatch(/thead\s*\{[^}]*display:\s*table-header-group/);
      expect(html).toMatch(/\.watermark\s*\{[^}]*position:\s*fixed/);

      const requests: string[] = [];
      const pdf = await renderPdf(browser, html, footer, pageSetup, requests);
      expect(requests).toEqual([]);
      const bytes = pdf.toString("latin1");
      expect(bytes.startsWith("%PDF-")).toBe(true);
      expect(bytes).toContain("%%EOF");
      expect(pdf.length).toBeGreaterThan(10_000);

      // The laid-out content spans more than one A4 page — a reliable,
      // parser-free multi-page proof (900 rows far exceed one printable page).
      expect(await printPageCount(browser, html, pageSetup)).toBeGreaterThan(1);
      // Opportunistic cross-check: Chromium's Pages node usually carries a plain
      // `/Count N`; assert it agrees when present (it is absent when stored in
      // an object stream, in which case the layout-height check above stands).
      const count = /\/Count\s+(\d+)/.exec(bytes);
      if (count) {
        expect(Number(count[1])).toBeGreaterThan(1);
      }
    }, 120_000);

    it("renders the final invoice (real INV number, no watermark) and a small detail yields a smaller PDF than the large one", async () => {
      const { render, renderFooter } = await loadSeededDefault();
      const pageSetup = await loadPageSetup();

      const smallRaw = rawInput(buildDetail(1, 1));
      smallRaw.document = {
        documentId: "INV00000042",
        postingDate: new Date("2026-07-05"),
      };
      const small = bind(smallRaw, {
        isDraft: false,
        locale: "en-MY",
        timezone: TZ,
        template: SEEDED_TEMPLATE_STAMP,
        profile: null,
        footnote: [...SEEDED_FOOTNOTE],
        invoiceNo: "INV00000042",
      });
      const smallHtml = render(small);
      expect(smallHtml).toContain("INV00000042");
      expect(smallHtml).not.toMatch(/class="watermark"/);

      const smallPdf = await renderPdf(
        browser,
        smallHtml,
        renderFooter(small),
        pageSetup,
      );
      expect(smallPdf.toString("latin1").startsWith("%PDF-")).toBe(true);

      const bigRaw = rawInput(buildDetail(9, 100));
      const big = bind(bigRaw, {
        isDraft: true,
        locale: "en-MY",
        timezone: TZ,
        template: SEEDED_TEMPLATE_STAMP,
        profile: null,
        footnote: [...SEEDED_FOOTNOTE],
      });
      const bigPdf = await renderPdf(
        browser,
        render(big),
        renderFooter(big),
        pageSetup,
      );

      // More polygons ⇒ more pages ⇒ a larger PDF (pagination proxy).
      expect(bigPdf.length).toBeGreaterThan(smallPdf.length);
    }, 120_000);

    // bm70-spec §6 / Inv #47 — the `ci` 2,000 Mbps bill renders page 1 to a
    // PDF with the IBM Plex faces loaded from the embedded @font-face data
    // and no network request at all.
    it("renders the ci 2,000 Mbps bill with embedded fonts and zero network requests (bm70)", async () => {
      const { render, renderFooter } = await loadSeededDefault();
      const pageSetup = await loadPageSetup();
      const raw = rawInput(buildDetail(1, 1));
      raw.document = {
        documentId: "INV00000070",
        postingDate: new Date("2026-07-05"),
      };
      const bound = bind(raw, {
        isDraft: false,
        locale: "en-MY",
        timezone: TZ,
        template: SEEDED_TEMPLATE_STAMP,
        profile: null,
        footnote: [...SEEDED_FOOTNOTE],
        invoiceNo: "INV00000070",
      });
      const html = render(bound);
      expect(html).toContain("Utilised capacity charges");
      expect(html).toContain("150,000.00");

      const page = await browser.newPage();
      const requests: string[] = [];
      page.on("request", (req) => {
        if (!req.url().startsWith("data:")) requests.push(req.url());
      });
      try {
        await page.setContent(html, { waitUntil: "networkidle" });
        const loaded = await page.evaluate(async () => {
          await document.fonts.ready;
          return [...document.fonts]
            .filter((f) => f.status === "loaded")
            .map((f) => `${f.family.replace(/"/g, "")} ${f.weight}`)
            .sort();
        });
        expect(loaded).toEqual([
          "IBM Plex Mono 400",
          "IBM Plex Sans 400",
          "IBM Plex Sans 600",
        ]);
        const pdf = await page.pdf({
          format: pageSetup.format,
          landscape: pageSetup.orientation === "landscape",
          printBackground: pageSetup.printBackground,
          margin: pageSetup.margin,
          displayHeaderFooter: true,
          headerTemplate: "<span></span>",
          footerTemplate: renderFooter(bound),
        });
        expect(pdf.toString("latin1").startsWith("%PDF-")).toBe(true);
        // The embedded faces are subset into the PDF.
        expect(pdf.toString("latin1")).toMatch(/IBMPlexSans/);
      } finally {
        await page.close();
      }
      expect(requests).toEqual([]);
    }, 120_000);
  },
);
