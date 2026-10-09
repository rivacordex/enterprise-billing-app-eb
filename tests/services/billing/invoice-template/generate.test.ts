import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

// The seeded layout v1 comes through the REAL verified loader (`loadLayout`):
// the blob transport serves the committed repo bytes, checked against the
// migration's checksum.
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
  annotatePlaceholders,
  generate,
  layoutFilesFromVerified,
  type LayoutFiles,
} from "@/services/billing/invoice-template/generate";
import {
  PROBE_RENDER_INPUT,
  loadLayout,
} from "@/services/billing/invoice-template/load";
import { SEEDED_LAYOUT_ROW } from "@/tests/helpers/seeded-invoice-template";
import {
  INVOICE_COLUMN_KEYS,
  INVOICE_OPTIONAL_SECTION_KEYS,
  InvoiceRenderError,
  type InvoiceColumnKey,
  type InvoiceTemplateStructure,
} from "@/types/billing";
import { invoiceTemplateStructureSchema } from "@/validation/billing/invoice-template-structure.schema";

// bm55-spec §Tests — guardrail 48 (code-standards Part 2 §9 item 48): the
// generator over every one of the 2⁷ = 128 combinations of the 3 optional
// sections × 4 columns, against the seeded layout v1.

const REPO_ROOT = path.resolve(__dirname, "../../../..");

let layout: LayoutFiles;

beforeAll(async () => {
  layout = layoutFilesFromVerified(await loadLayout(SEEDED_LAYOUT_ROW));
});

function structureFor(mask: number): InvoiceTemplateStructure {
  const bit = (i: number): boolean => (mask & (1 << i)) !== 0;
  return {
    sections: {
      billTo: true,
      identification: true,
      amountDue: true,
      chargeSummary: true,
      taxSummary: true,
      chargeDetails: true,
      payment: bit(0),
      usageAnnex: bit(1),
      notes: bit(2),
    },
    columns: {
      showServicePeriod: bit(3),
      showDiscountColumn: bit(4),
      showProductId: bit(5),
      showUdrCount: bit(6),
    },
  };
}

const ALL_ON = structureFor(127);

const COLUMN_HEADERS: Record<InvoiceColumnKey, string> = {
  showServicePeriod: "<th>Service period</th>",
  showDiscountColumn: '<th class="num">Discount</th>',
  showProductId: "<th>Offering ID</th>",
  showUdrCount: "<th>UDR type / count</th>",
};

// Each optional section's distinctive markup in the generated file.
const SECTION_MARKERS = {
  payment: "sec--payment",
  usageAnnex: "Usage annex — billed usage by region",
  notes: "sec--notes",
} as const;

function chargeDetails(hbs: string): string {
  const start = hbs.indexOf("sec--chargeDetails");
  const end = hbs.indexOf("</section>", start);
  return hbs.slice(start, end);
}

function expectedColCount(s: InvoiceTemplateStructure): number {
  return 6 + INVOICE_COLUMN_KEYS.filter((k) => s.columns[k]).length;
}

function expectGenerationFailed(fn: () => unknown, file: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvoiceRenderError);
    expect((error as InvoiceRenderError).code).toBe(
      "TEMPLATE_GENERATION_FAILED",
    );
    expect((error as InvoiceRenderError).detail).toMatchObject({ file });
    return;
  }
  throw new Error("expected TEMPLATE_GENERATION_FAILED");
}

function withPartial(
  key: keyof LayoutFiles["partials"],
  source: string,
): LayoutFiles {
  return { ...layout, partials: { ...layout.partials, [key]: source } };
}

describe("generate — guardrail 48 (all 128 structure combinations)", () => {
  const masks = Array.from({ length: 128 }, (_, mask) => mask);

  it.each(masks)(
    "combination %i compiles, has no directive, and drops hidden markup",
    (mask) => {
      const structure = structureFor(mask);
      const { invoiceHbs, footerHbs } = generate(layout, structure);

      // Compiles under knownHelpersOnly + strict, and executes.
      const invoice = compileInvoiceTemplate(invoiceHbs);
      const footer = compileInvoiceTemplate(footerHbs);
      expect(executeInvoiceTemplate(invoice, PROBE_RENDER_INPUT)).toContain(
        "<html>",
      );
      executeInvoiceTemplate(footer, PROBE_RENDER_INPUT);

      // No generation directive survives (Inv #46).
      for (const file of [invoiceHbs, footerHbs]) {
        expect(file).not.toContain("[[");
        expect(file).not.toContain("]]");
        expect(file).not.toContain("\r");
      }

      // Hidden means absent (Styling rule 5).
      for (const key of INVOICE_OPTIONAL_SECTION_KEYS) {
        if (structure.sections[key]) {
          expect(invoiceHbs).toContain(SECTION_MARKERS[key]);
        } else {
          expect(invoiceHbs).not.toContain(SECTION_MARKERS[key]);
        }
      }
      for (const key of INVOICE_COLUMN_KEYS) {
        expect(invoiceHbs.includes(COLUMN_HEADERS[key])).toBe(
          structure.columns[key],
        );
      }
      // A hidden Discount column also drops its line cell and group total.
      expect(invoiceHbs.includes("this.discountTotal")).toBe(
        structure.columns.showDiscountColumn,
      );
      expect(invoiceHbs.includes("this.discountAmount negate=true")).toBe(
        structure.columns.showDiscountColumn,
      );

      // colspan values equal the formulas, and the header row has colCount cells.
      const details = chargeDetails(invoiceHbs);
      const colCount = expectedColCount(structure);
      const discount = structure.columns.showDiscountColumn ? 1 : 0;
      const spans = [...details.matchAll(/colspan="(\d+)"/g)].map((m) =>
        Number(m[1]),
      );
      expect(spans).toEqual([colCount, colCount - 2 - discount]);
      const thead = details.slice(0, details.indexOf("</thead>"));
      expect(thead.match(/<th[ >]/g)).toHaveLength(colCount);
    },
  );
});

describe("generate — layout pairing", () => {
  it("keeps the mandatory identification/billTo pair half-width", () => {
    const { invoiceHbs } = generate(layout, ALL_ON);
    expect(invoiceHbs).toContain('class="sec sec--identification sec--half"');
    expect(invoiceHbs).toContain('class="sec sec--billTo sec--half"');
  });

  it("keeps a half section authored without a layout partner half (payment in v1)", () => {
    const { invoiceHbs } = generate(layout, ALL_ON);
    expect(invoiceHbs).toContain('class="sec sec--payment sec--half"');
  });

  it("widens a half section to full when its layout partner is hidden", () => {
    // Synthetic layout: make the Usage annex a half section after payment, so
    // payment and usageAnnex form a pair.
    const paired = withPartial(
      "usageAnnex",
      '<section class="sec sec--usageAnnex sec--half">\n  <p>Usage annex</p>\n</section>\n',
    );

    const both = generate(paired, ALL_ON).invoiceHbs;
    expect(both).toContain('class="sec sec--payment sec--half"');
    expect(both).toContain('class="sec sec--usageAnnex sec--half"');

    const noAnnex = generate(paired, {
      ...ALL_ON,
      sections: { ...ALL_ON.sections, usageAnnex: false },
    }).invoiceHbs;
    expect(noAnnex).toContain('class="sec sec--payment sec--full"');
    expect(noAnnex).not.toContain("sec--usageAnnex");

    const noPayment = generate(paired, {
      ...ALL_ON,
      sections: { ...ALL_ON.sections, payment: false },
    }).invoiceHbs;
    expect(noPayment).toContain('class="sec sec--usageAnnex sec--full"');
    expect(noPayment).not.toContain("sec--payment");
  });
});

describe("generate — the mandatory-section rule", () => {
  it("the Zod schema rejects a hidden mandatory section with MANDATORY_SECTION_HIDDEN", () => {
    const parsed = invoiceTemplateStructureSchema.safeParse({
      ...ALL_ON,
      sections: { ...ALL_ON.sections, chargeDetails: false },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["sections", "chargeDetails"],
        message: "MANDATORY_SECTION_HIDDEN",
      }),
    ]);
  });

  it("the Zod schema rejects unknown keys (no admin markup can ride along)", () => {
    expect(
      invoiceTemplateStructureSchema.safeParse({ ...ALL_ON, css: "x" }).success,
    ).toBe(false);
    expect(
      invoiceTemplateStructureSchema.safeParse({
        ...ALL_ON,
        sections: { ...ALL_ON.sections, accountSummary: true },
      }).success,
    ).toBe(false);
  });

  it("generate re-asserts it", () => {
    expect(() =>
      generate(layout, {
        ...ALL_ON,
        sections: { ...ALL_ON.sections, billTo: false },
      }),
    ).toThrow(
      expect.objectContaining({ code: "MANDATORY_SECTION_HIDDEN" }) as Error,
    );
  });
});

describe("generate — TEMPLATE_GENERATION_FAILED", () => {
  it("rejects a nested [[if]]", () => {
    expectGenerationFailed(
      () =>
        generate(
          withPartial(
            "notes",
            "[[if sections.notes]]a[[if columns.showUdrCount]]b[[/if]][[/if]]",
          ),
          ALL_ON,
        ),
      "partials/notes.hbs",
    );
  });

  it("rejects an unknown directive", () => {
    expectGenerationFailed(
      () => generate(withPartial("notes", "[[else]]"), ALL_ON),
      "partials/notes.hbs",
    );
  });

  it("rejects an unknown key", () => {
    expectGenerationFailed(
      () =>
        generate(
          withPartial("notes", "[[if sections.accountSummary]]x[[/if]]"),
          ALL_ON,
        ),
      "partials/notes.hbs",
    );
    expectGenerationFailed(
      () => generate(withPartial("notes", "[[num rowCount]]"), ALL_ON),
      "partials/notes.hbs",
    );
  });

  it("rejects an unbalanced [[if]]", () => {
    expectGenerationFailed(
      () => generate(withPartial("notes", "[[if sections.notes]]x"), ALL_ON),
      "partials/notes.hbs",
    );
    expectGenerationFailed(
      () => generate(withPartial("notes", "x[[/if]]"), ALL_ON),
      "partials/notes.hbs",
    );
  });

  it("rejects a [[body]] count other than one in shell.hbs, and [[body]] in a partial", () => {
    expectGenerationFailed(
      () =>
        generate(
          { ...layout, shell: layout.shell.replace("[[body]]", "") },
          ALL_ON,
        ),
      "shell.hbs",
    );
    expectGenerationFailed(
      () => generate({ ...layout, shell: `${layout.shell}[[body]]` }, ALL_ON),
      "shell.hbs",
    );
    expectGenerationFailed(
      () => generate(withPartial("notes", "[[body]]"), ALL_ON),
      "partials/notes.hbs",
    );
  });

  it("rejects output that still carries a directive bracket", () => {
    expectGenerationFailed(
      () => generate(withPartial("notes", "<p>[[ unterminated</p>"), ALL_ON),
      "invoice.hbs",
    );
  });
});

describe("generate — annotate (preview only)", () => {
  it("wraps text-content placeholders only, never attributes, CSS or block helpers", () => {
    const plain = generate(layout, ALL_ON).invoiceHbs;
    const annotated = generate(layout, ALL_ON, { annotate: true }).invoiceHbs;

    expect(plain).not.toContain('class="ph"');
    expect(annotated).toContain(
      '<span class="ph" data-ph="customer.name">{{customer.name}}</span>',
    );
    expect(annotated).toContain(
      '<span class="ph" data-ph="money this.netAmount">{{money this.netAmount}}</span>',
    );
    // Attribute placeholders are untouched.
    expect(annotated).toContain(
      '<img src="{{company.logoUrl}}" alt="{{company.name}}"',
    );
    expect(annotated).not.toContain('data-ph="company.logoUrl"');
    // Raw-text (<style>) placeholders are untouched.
    expect(annotated).toContain(
      "--inv-brand: {{#if company}}{{company.brandColor}}{{else}}#2E45A9{{/if}};",
    );
    // Block helpers are untouched.
    expect(annotated).not.toMatch(/data-ph="[#/]/);
    expect(annotated).not.toContain('data-ph="else"');

    // Still compiles and renders under the locked-down options.
    const html = executeInvoiceTemplate(
      compileInvoiceTemplate(annotated),
      PROBE_RENDER_INPUT,
    );
    expect(html).toContain(
      '<span class="ph" data-ph="customer.name">Probe Customer Sdn Bhd</span>',
    );
  });

  it("escapes an expression inside data-ph", () => {
    expect(annotatePlaceholders('<p>{{a "b"}}</p>')).toBe(
      '<p><span class="ph" data-ph="a &quot;b&quot;">{{a "b"}}</span></p>',
    );
  });
});

describe("generate — determinism and structure.json", () => {
  it("is deterministic and LF-only", () => {
    const crlf: LayoutFiles = {
      ...layout,
      shell: layout.shell.replace(/\n/g, "\r\n"),
    };
    expect(generate(crlf, ALL_ON)).toEqual(generate(layout, ALL_ON));
  });

  it("writes structure.json canonically (sorted keys, 2-space, trailing LF)", () => {
    const { structureJson } = generate(layout, ALL_ON);
    expect(structureJson.endsWith("}\n")).toBe(true);
    const parsed = JSON.parse(structureJson) as InvoiceTemplateStructure;
    expect(parsed).toEqual(ALL_ON);
    expect(Object.keys(parsed)).toEqual(["columns", "sections"]);
    expect(Object.keys(parsed.sections)).toEqual(
      [...Object.keys(ALL_ON.sections)].sort(),
    );
    expect(structureJson).toBe(
      `${JSON.stringify(
        {
          columns: Object.fromEntries(
            Object.entries(ALL_ON.columns).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          ),
          sections: Object.fromEntries(
            Object.entries(ALL_ON.sections).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          ),
        },
        null,
        2,
      )}\n`,
    );
  });
});

describe("generate — never in a client bundle (code-standards Part 2 Next.js rule 8)", () => {
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sources(p));
      else if (/\.tsx?$/.test(entry.name)) out.push(p);
    }
    return out;
  }

  it("no 'use client' module imports handlebars or the invoice-template services", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "components"]) {
      for (const file of sources(path.join(REPO_ROOT, dir))) {
        const src = fs.readFileSync(file, "utf8");
        if (!/^\s*["']use client["']/.test(src)) continue;
        if (
          /from ["']handlebars["']/.test(src) ||
          src.includes("@/services/billing/invoice-template")
        ) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the generator imports no next/* and no DB/blob module", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "services/billing/invoice-template/generate.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from ["']next\//);
    expect(src).not.toContain("@/db/");
    expect(src).not.toContain("blob-store");
    expect(src).not.toMatch(/from ["']handlebars["']/);
  });
});
