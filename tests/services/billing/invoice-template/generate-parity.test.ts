import { beforeAll, describe, expect, it, vi } from "vitest";

// Both sides come through the REAL verified loaders (checksums checked against
// the migration's rows); the blob transport serves the committed repo bytes.
vi.mock(
  "@/services/billing/blob-store",
  async () =>
    (await import("@/tests/helpers/seeded-invoice-template"))
      .repoBlobStoreModule,
);

import {
  compileInvoiceTemplate,
  executeInvoiceTemplate,
} from "@/services/billing/invoice-template/compile";
import {
  generate,
  layoutFilesFromVerified,
} from "@/services/billing/invoice-template/generate";
import {
  PROBE_RENDER_INPUT,
  loadGeneratedFiles,
  loadLayout,
} from "@/services/billing/invoice-template/load";
import {
  SEEDED_GENERATED_ROW,
  SEEDED_LAYOUT_ROW,
} from "@/tests/helpers/seeded-invoice-template";
import type { InvoiceRenderInput } from "@/types/billing";

// bm55-spec §Design D1 "Parity with the bm47 hand-written default" — the stored
// generated v1 `invoice.hbs` was hand-written (bm47) and seeded immutably
// (bm50). Semantic parity: generate(layout v1, all-true) and the stored v1,
// each compiled, render the same HTML for the layout's `sample-data.json` and
// for a multi-page fixture.
//
// KNOWN GAP (owner decision 2026-10-09; known-issues §20): the two differ in
// the `<head>` `<style>` only — layout v1's `shell.hbs` was frozen without the
// bm49 usage-annex CSS (and with different CSS comments) that the hand-written
// v1 carries. Layout v1 is immutable (Inv #44), so the fix is a layout v2.
// The `<body>` is byte-identical; the whole-document test below is marked
// `fails` so it turns red — and must be flipped — once a layout carries the CSS.

let generatedHtml: (input: InvoiceRenderInput) => string;
let storedHtml: (input: InvoiceRenderInput) => string;
let sampleData: InvoiceRenderInput;

beforeAll(async () => {
  const layoutFiles = await loadLayout(SEEDED_LAYOUT_ROW);
  const generated = generate(layoutFilesFromVerified(layoutFiles), {
    sections: {
      billTo: true,
      identification: true,
      amountDue: true,
      chargeSummary: true,
      taxSummary: true,
      payment: true,
      chargeDetails: true,
      usageAnnex: true,
      notes: true,
    },
    columns: {
      showServicePeriod: true,
      showDiscountColumn: true,
      showProductId: true,
      showUdrCount: true,
    },
  });
  const stored = await loadGeneratedFiles(SEEDED_GENERATED_ROW);

  const generatedTpl = compileInvoiceTemplate(generated.invoiceHbs);
  const storedTpl = compileInvoiceTemplate(
    stored["invoice.hbs"].toString("utf-8"),
  );
  generatedHtml = (input) => executeInvoiceTemplate(generatedTpl, input);
  storedHtml = (input) => executeInvoiceTemplate(storedTpl, input);

  sampleData = JSON.parse(
    layoutFiles.get("sample-data.json")!.toString("utf-8"),
  ) as InvoiceRenderInput;
});

// 3 groups × 40 lines plus a 3 × 4 × 50-row usage annex — several A4 pages
// (the guardrail-54 shape: repeated thead, line groups, a long annex).
function multiPageInput(): InvoiceRenderInput {
  const base = PROBE_RENDER_INPUT;
  const lineGroups = base.lineGroups.map((group, g) => ({
    ...group,
    lines: Array.from({ length: 40 }, (_, i) => ({
      ...group.lines[0]!,
      lineNo: g * 40 + i + 1,
      description: `${group.name} line ${i + 1} <b>&</b>`,
    })),
  }));
  const state = base.usage!.states[0]!;
  const district = state.districts[0]!;
  const states = Array.from({ length: 3 }, (_, s) => ({
    ...state,
    state: `State-${s + 1}`,
    label: `State ${s + 1}`,
    districts: Array.from({ length: 4 }, (_, d) => ({
      ...district,
      district: `District-${s + 1}-${d + 1}`,
      label: `District ${s + 1}.${d + 1}`,
      rows: Array.from({ length: 50 }, (_, r) => ({
        ...district.rows[0]!,
        cell: `CELL-${s + 1}-${d + 1}-${r + 1}`,
      })),
    })),
  }));
  return {
    ...base,
    lineGroups,
    usage: { ...base.usage!, states },
    isDraft: true,
    invoice: { ...base.invoice, isDraft: true, number: null },
  };
}

function bodyOf(html: string): string {
  const at = html.indexOf("<body>");
  expect(at).toBeGreaterThan(-1);
  return html.slice(at);
}

describe("generate ↔ stored v1 semantic parity (bm55 D1)", () => {
  it.each([
    ["sample-data.json as issued", () => ({ ...sampleData, isDraft: false })],
    [
      "sample-data.json as a draft",
      () => ({
        ...sampleData,
        isDraft: true,
        invoice: { ...sampleData.invoice, isDraft: true },
      }),
    ],
    ["the multi-page fixture", multiPageInput],
  ])("renders a byte-identical <body> for %s", (_label, input) => {
    const data = input();
    const generated = generatedHtml(data);
    const stored = storedHtml(data);
    expect(bodyOf(generated)).toBe(bodyOf(stored));
    // Sanity: the fixture really exercised the sections.
    expect(bodyOf(stored)).toContain("sec--chargeDetails");
  });

  it("the multi-page fixture is long (many line rows and annex rows)", () => {
    const html = storedHtml(multiPageInput());
    expect(html.match(/<tr>/g)!.length).toBeGreaterThan(600);
  });

  it.fails(
    "renders a byte-identical whole document (KNOWN GAP: layout v1 <style> lacks the annex CSS)",
    () => {
      expect(generatedHtml(sampleData)).toBe(storedHtml(sampleData));
    },
  );

  it("the only <head> difference is the stylesheet: the stored v1 styles the annex, layout v1 does not", () => {
    const generated = generatedHtml(sampleData);
    const stored = storedHtml(sampleData);
    const head = (html: string) => html.slice(0, html.indexOf("<body>"));
    expect(head(stored)).toContain(".annex {");
    expect(head(generated)).not.toContain(".annex {");
    // Outside <style>, the heads match.
    const strip = (html: string) =>
      head(html).replace(/<style>[\s\S]*<\/style>/, "<style/>");
    expect(strip(generated)).toBe(strip(stored));
  });
});
