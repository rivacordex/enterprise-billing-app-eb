import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

import { bind } from "@/services/billing/invoice-template/bind";
import { loadDefaultTemplateFromRepo } from "@/services/billing/invoice-template/load-stopgap";
import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import { layoutPageSetupSchema } from "@/validation/billing/layout-page-setup.schema";

// bm49 — a REAL Chromium render (not the mocked `render-invoice.service.test.ts`)
// that drives the actually-seeded generated template through `bind` → Handlebars
// → Chromium PDF, exercising the new state→district usage annex end to end. The
// pipeline needs no DB (the stopgap loader reads the repo `.hbs`), so this is
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

interface UsageRow {
  startDate: string;
  cell: string;
  udrType: string;
  quantity: string;
  unit: string;
  amount: string;
  state: string | null;
  district: string | null;
}

// Build a consistent usage read (rows + GROUPING SETS-shaped groups) with JS
// sums — this is fixture scaffolding, the production subtotal math is SQL's.
function buildUsage(states: number, districts: number, rowsPer: number) {
  const rows: UsageRow[] = [];
  for (let si = 0; si < states; si++) {
    const st = `State-${String(si + 1).padStart(2, "0")}`;
    for (let di = 0; di < districts; di++) {
      const dt = `${st}-District-${di + 1}`;
      for (let ri = 0; ri < rowsPer; ri++) {
        rows.push({
          startDate: "2026-06-03",
          cell: `cell-${si + 1}-${di + 1}-${ri + 1}`,
          udrType: "RAN_USAGE",
          quantity: "10.000000",
          unit: "EA",
          amount: "100.00",
          state: st,
          district: dt,
        });
      }
    }
  }
  const money = (n: number) => n.toFixed(2);
  const qty = (n: number) => n.toFixed(6);

  const districtGroups = new Map<
    string,
    { state: string; district: string; count: number }
  >();
  const stateGroups = new Map<string, { state: string; count: number }>();
  for (const r of rows) {
    const dk = `${r.state}|${r.district}`;
    const dg = districtGroups.get(dk) ?? {
      state: r.state!,
      district: r.district!,
      count: 0,
    };
    dg.count += 1;
    districtGroups.set(dk, dg);
    const sg = stateGroups.get(r.state!) ?? { state: r.state!, count: 0 };
    sg.count += 1;
    stateGroups.set(r.state!, sg);
  }

  const groups = [
    ...[...districtGroups.values()].map((g) => ({
      state: g.state,
      district: g.district,
      gState: 0,
      gDistrict: 0,
      rowCount: g.count,
      amount: money(g.count * 100),
      quantity: qty(g.count * 10),
      unit: "EA",
    })),
    ...[...stateGroups.values()].map((g) => ({
      state: g.state,
      district: null,
      gState: 0,
      gDistrict: 1,
      rowCount: g.count,
      amount: money(g.count * 100),
      quantity: qty(g.count * 10),
      unit: "EA",
    })),
    {
      state: null,
      district: null,
      gState: 1,
      gDistrict: 1,
      rowCount: rows.length,
      amount: money(rows.length * 100),
      quantity: qty(rows.length * 10),
      unit: "EA",
    },
  ];

  return { rows, groups, grandAmount: money(rows.length * 100) };
}

function rawInput(usage: ReturnType<typeof buildUsage>): RawInvoiceRenderInput {
  return {
    bill: {
      customerBillId: "CBL00000001",
      periodPartition: "2026-06-01",
      billingAccountId: "BAN00000001",
      currency: "MYR",
      billingPeriodStart: "2026-06-01",
      billingPeriodEnd: "2026-06-30",
      paymentDueDate: "2026-07-15",
      subtotal: "0.00",
      taxTotal: "0.00",
      totalAmount: "0.00",
      linesNetSum: "0.00",
      grossTotal: "0.00",
      discountTotal: "0.00",
      usageRatedTotal: usage.grandAmount,
    },
    run: { billRunId: "BRN00000042", cycleName: "Enterprise Monthly" },
    lines: [],
    taxItems: [],
    document: null,
    customer: {
      name: "Acme Communications Sdn Bhd",
      tradingName: null,
      registrationNumber: null,
      taxId: null,
      email: null,
      phone: null,
      address: null,
    },
    usage: { overLimit: false, rows: usage.rows, groups: usage.groups },
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
): Promise<Buffer> {
  const page = await browser.newPage();
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

describe.skipIf(!run)(
  "bm49 invoice render — real Chromium (RUN_CHROMIUM_E2E=1)",
  () => {
    let browser: Browser;

    beforeAll(async () => {
      browser = await chromium.launch();
    }, 60_000);

    afterAll(async () => {
      if (browser) await browser.close();
    });

    it("renders a valid multi-page PDF for a large state→district annex (draft), with the Page X of Y footer wired", async () => {
      const { render, renderFooter } = await loadDefaultTemplateFromRepo();
      const pageSetup = await loadPageSetup();

      // 8 states × 4 districts × 4 rows = 128 itemised records → well over one A4
      // page at the §10c 8pt table size.
      const big = bind(rawInput(buildUsage(8, 4, 4)), {
        isDraft: true,
        locale: "en-MY",
        timezone: TZ,
        includeUsage: true,
      });
      const html = render(big);
      const footer = renderFooter(big);

      // The footer Chromium repeats per page carries the page-number spans.
      expect(footer).toContain('class="pageNumber"');
      expect(footer).toContain('class="totalPages"');
      // thead repeats across page breaks; watermark is a fixed layer (not clipped).
      expect(html).toContain("Usage annex — billed usage by region");
      expect(html).toMatch(/thead\s*\{[^}]*display:\s*table-header-group/);
      expect(html).toMatch(/\.watermark\s*\{[^}]*position:\s*fixed/);

      const pdf = await renderPdf(browser, html, footer, pageSetup);
      const bytes = pdf.toString("latin1");
      expect(bytes.startsWith("%PDF-")).toBe(true);
      expect(bytes).toContain("%%EOF");
      expect(pdf.length).toBeGreaterThan(10_000);

      // Opportunistic real page count: Chromium's Pages node usually carries a
      // plain `/Count N`. When present (not inside an object stream), assert
      // multi-page; otherwise the size + structural checks above stand.
      const count = /\/Count\s+(\d+)/.exec(bytes);
      if (count) {
        expect(Number(count[1])).toBeGreaterThan(1);
      }
    }, 120_000);

    it("renders the final invoice (real INV number, no watermark) and a small annex yields a smaller PDF than the large one", async () => {
      const { render, renderFooter } = await loadDefaultTemplateFromRepo();
      const pageSetup = await loadPageSetup();

      const smallRaw = rawInput(buildUsage(1, 1, 1));
      smallRaw.document = {
        documentId: "INV00000042",
        postingDate: new Date("2026-07-05"),
      };
      const small = bind(smallRaw, {
        isDraft: false,
        locale: "en-MY",
        timezone: TZ,
        includeUsage: true,
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

      const bigRaw = rawInput(buildUsage(8, 4, 4));
      const big = bind(bigRaw, {
        isDraft: true,
        locale: "en-MY",
        timezone: TZ,
        includeUsage: true,
      });
      const bigPdf = await renderPdf(
        browser,
        render(big),
        renderFooter(big),
        pageSetup,
      );

      // More itemised records ⇒ more pages ⇒ a larger PDF (pagination proxy).
      expect(bigPdf.length).toBeGreaterThan(smallPdf.length);
    }, 120_000);
  },
);
