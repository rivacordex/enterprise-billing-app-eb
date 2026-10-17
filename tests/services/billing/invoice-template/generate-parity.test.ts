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
  type GeneratedTemplateFiles,
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
import type {
  InvoiceRenderInput,
  InvoiceServiceType,
  InvoiceTemplateStructure,
} from "@/types/billing";

// bm55-spec §Design D1 "Parity with the bm47 hand-written default" — the stored
// generated v1 `invoice.hbs` is seeded immutably per round (bm50). Semantic
// parity: generate(layout v1, all-true) and the stored v1, each compiled,
// render the same HTML for the layout's `sample-data.json` and for a
// multi-page fixture.
//
// bm70 (D60) rewrote layout v1 and regenerated the stored v1 with the
// generator (`scripts/invoice-templates/regenerate-generated.ts`). The
// rewritten `shell.hbs` carries the bm49 usage-annex CSS, so the former
// `<head>` gap (known-issues §20) is closed: the whole document is identical.
//
// bm71 replaced the annex with the detail pages and regenerated all three
// stored files from the seeded `structure.json` (payment + notes on, no
// columns): `invoice.hbs`, `footer.hbs` and `structure.json` are each
// byte-identical to the generator output.

const SEEDED_STRUCTURE: InvoiceTemplateStructure = {
  sections: { payment: true, notes: true },
  columns: {},
};

let generatedHtml: (input: InvoiceRenderInput) => string;
let generatedFiles: GeneratedTemplateFiles;
let storedFiles: Awaited<ReturnType<typeof loadGeneratedFiles>>;
let storedHtml: (input: InvoiceRenderInput) => string;
let sampleData: InvoiceRenderInput;

beforeAll(async () => {
  const layoutFiles = await loadLayout(SEEDED_LAYOUT_ROW);
  const generated = generate(
    layoutFilesFromVerified(layoutFiles),
    SEEDED_STRUCTURE,
  );
  const stored = await loadGeneratedFiles(SEEDED_GENERATED_ROW);
  generatedFiles = generated;
  storedFiles = stored;

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

// 2 types × 3 State-District groups × 150 polygons — many A4 pages (the
// guardrail-64 shape: a type per page break, repeated group thead, groups
// spanning pages), plus a type with no claimed row.
function multiPageInput(): InvoiceRenderInput {
  const base = PROBE_RENDER_INPUT;
  const template = base.serviceTypes[0]!;
  const row = template.regions[0]!.rows[0]!;
  const types: InvoiceServiceType[] = Array.from({ length: 2 }, (_, t) => ({
    ...template,
    offeringId: `POF0000010${t}`,
    label: `Capacity type ${t + 1} <b>&</b>`,
    regions: Array.from({ length: 3 }, (_, r) => ({
      label: `STATE-${r + 1} - DISTRICT-${r + 1}`,
      subTotal: "150.00",
      rows: Array.from({ length: 150 }, (_, i) => ({
        ...row,
        polygonName: `POLY-${t + 1}-${r + 1}-${i + 1}`,
      })),
    })),
  }));
  return {
    ...base,
    serviceTypes: [...types, base.serviceTypes[1]!],
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

  it("the multi-page fixture is long (many detail rows)", () => {
    const html = storedHtml(multiPageInput());
    expect(html.match(/<tr>/g)!.length).toBeGreaterThan(600);
  });

  it("renders a byte-identical whole document, stylesheet included", () => {
    expect(generatedHtml(sampleData)).toBe(storedHtml(sampleData));
    expect(storedHtml(sampleData)).toContain(".detail-group {");
  });

  it("stores exactly the generator output for footer.hbs and structure.json (bm71)", () => {
    expect(storedFiles["footer.hbs"].toString("utf-8")).toBe(
      generatedFiles.footerHbs,
    );
    expect(storedFiles["structure.json"].toString("utf-8")).toBe(
      generatedFiles.structureJson,
    );
    expect(storedFiles["invoice.hbs"].toString("utf-8")).toBe(
      generatedFiles.invoiceHbs,
    );
  });
});
