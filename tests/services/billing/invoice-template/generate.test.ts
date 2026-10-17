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
  INVOICE_OPTIONAL_SECTION_KEYS,
  InvoiceRenderError,
  type InvoiceTemplateStructure,
} from "@/types/billing";
import { invoiceTemplateStructureSchema } from "@/validation/billing/invoice-template-structure.schema";
import { layoutManifestSchema } from "@/validation/billing/layout-manifest.schema";

// bm55-spec §Tests — guardrail 48, shrunk by bm71-spec §6 and bm72-spec §5
// (guardrail item 67, D56): the generator over both cases of the one optional
// section (payment on/off; the column toggles and Notes & terms are gone),
// against the seeded layout v1. bm71 also pins the structure schema and the
// layout manifest schema (D38); bm72 adds the footnote lines to the schema.

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  "db/seeds/invoice-templates/INVTPL-STD-A4/v1/manifest.json",
);

let layout: LayoutFiles;

beforeAll(async () => {
  layout = layoutFilesFromVerified(await loadLayout(SEEDED_LAYOUT_ROW));
});

const FOOTNOTE = [
  "Calculations are done in Mbps",
  "This invoice is billed exclusive of Universal Service Provision (USP)",
];

function structureFor(mask: number): InvoiceTemplateStructure {
  return {
    sections: { payment: (mask & 1) !== 0 },
    columns: {},
    footnote: [...FOOTNOTE],
  };
}

const ALL_ON = structureFor(1);

// Each optional section's distinctive markup in the generated file.
const SECTION_MARKERS = {
  payment: "sec--payment",
} as const;

// The mandatory sections the layout always generates.
const MANDATORY_MARKERS = [
  "sec--header",
  "sec--identification",
  "sec--billTo",
  "sec--chargeSummary",
  "sec--taxSummary",
  "sec--amountDue",
  "sec--chargeDetails",
];

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

describe("generate — guardrail 67 (both payment cases)", () => {
  const masks = [0, 1];

  it.each(masks)(
    "combination %i compiles, has no directive, and drops hidden markup",
    (mask) => {
      const structure = structureFor(mask);
      const { invoiceHbs, footerHbs } = generate(layout, structure);

      // Compiles under knownHelpersOnly + strict, and executes.
      const invoice = compileInvoiceTemplate(invoiceHbs);
      const footer = compileInvoiceTemplate(footerHbs);
      expect(executeInvoiceTemplate(invoice, PROBE_RENDER_INPUT)).toContain(
        '<html lang="en">',
      );
      executeInvoiceTemplate(footer, PROBE_RENDER_INPUT);

      // No generation directive survives (Inv #46).
      for (const file of [invoiceHbs, footerHbs]) {
        expect(file).not.toContain("[[");
        expect(file).not.toContain("]]");
        expect(file).not.toContain("\r");
      }

      // Hidden means absent (Styling rule 5); mandatory means always there.
      for (const key of INVOICE_OPTIONAL_SECTION_KEYS) {
        expect(invoiceHbs.includes(SECTION_MARKERS[key])).toBe(
          structure.sections[key],
        );
      }
      for (const marker of MANDATORY_MARKERS) {
        expect(invoiceHbs).toContain(marker);
      }
      // The detail pages carry no admin column toggle (D56).
      expect(invoiceHbs).toContain('<table class="detail-group">');
      expect(invoiceHbs).not.toContain("annex");
      // Notes & terms is gone; the footnote is bound data (bm72).
      expect(invoiceHbs).not.toContain("sec--notes");
      expect(invoiceHbs).toContain("{{#each footnote}}");
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
    // Synthetic layout: make Amount due a half section; v1 orders it directly
    // before payment, so amountDue and payment form a pair. Payment is the
    // only optional section (bm72), so it is the partner that hides.
    const paired = withPartial(
      "amountDue",
      '<section class="sec sec--amountDue sec--half">\n  <p>Due</p>\n</section>\n',
    );

    const both = generate(paired, ALL_ON).invoiceHbs;
    expect(both).toContain('class="sec sec--amountDue sec--half"');
    expect(both).toContain('class="sec sec--payment sec--half"');

    const noPayment = generate(paired, structureFor(0)).invoiceHbs;
    expect(noPayment).toContain('class="sec sec--amountDue sec--full"');
    expect(noPayment).not.toContain("sec--payment");
  });
});

describe("generate — the structure schema (bm71/bm72, D56, guardrail 67)", () => {
  it("accepts both payment cases with an empty columns map and 1–5 footnote lines", () => {
    for (const mask of [0, 1]) {
      expect(
        invoiceTemplateStructureSchema.safeParse(structureFor(mask)).success,
      ).toBe(true);
    }
    for (const footnote of [
      ["x"],
      ["a", "b", "c", "d", "e"],
      ["y".repeat(200)],
    ]) {
      expect(
        invoiceTemplateStructureSchema.safeParse({ ...ALL_ON, footnote })
          .success,
      ).toBe(true);
    }
  });

  it("trims each footnote line", () => {
    expect(
      invoiceTemplateStructureSchema.parse({
        ...ALL_ON,
        footnote: ["  Calculations are done in Mbps  "],
      }).footnote,
    ).toEqual(["Calculations are done in Mbps"]);
  });

  it("rejects usageAnnex, notes, a mandatory section key and any column key", () => {
    const rejected = [
      { ...ALL_ON, sections: { ...ALL_ON.sections, usageAnnex: true } },
      { ...ALL_ON, sections: { ...ALL_ON.sections, notes: true } },
      { ...ALL_ON, sections: { ...ALL_ON.sections, chargeDetails: true } },
      { ...ALL_ON, columns: { showUdrCount: true } },
      { ...ALL_ON, columns: { showServicePeriod: false } },
    ];
    for (const structure of rejected) {
      expect(invoiceTemplateStructureSchema.safeParse(structure).success).toBe(
        false,
      );
    }
  });

  it.each([
    ["no footnote", undefined, "Required"],
    ["0 footnote lines", [], "Keep at least one line"],
    ["6 footnote lines", ["1", "2", "3", "4", "5", "6"], "5 lines at most"],
    ["a 201-character line", ["z".repeat(201)], "200 characters at most"],
    ["a whitespace-only line", ["ok", "   "], "Enter text or remove the line"],
    ["an empty line", [""], "Enter text or remove the line"],
  ])("rejects %s", (_label, footnote, message) => {
    const result = invoiceTemplateStructureSchema.safeParse({
      ...ALL_ON,
      footnote,
    });
    expect(result.success).toBe(false);
    if (message !== "Required") {
      expect(result.error?.issues.map((i) => i.message)).toContain(message);
    }
  });

  it("rejects unknown keys (no admin markup can ride along)", () => {
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
});

describe("generate — the layout manifest schema (bm71, D38)", () => {
  const seeded = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Record<
    string,
    unknown
  >;

  it("parses the seeded v1 manifest, keeping its section order", () => {
    const manifest = layoutManifestSchema.parse(seeded);
    expect(Object.keys(manifest.sections)).toEqual([
      "header",
      "identification",
      "billTo",
      "chargeSummary",
      "taxSummary",
      "amountDue",
      "payment",
      "chargeDetails",
    ]);
    expect(manifest.columns).toEqual({});
    // Guardrail 67 — the optional section keys are exactly `payment`.
    expect(
      Object.entries(manifest.sections)
        .filter(([, s]) => !s.mandatory)
        .map(([key]) => key),
    ).toEqual([...INVOICE_OPTIONAL_SECTION_KEYS]);
    expect(INVOICE_OPTIONAL_SECTION_KEYS).toEqual(["payment"]);
    expect(manifest.usageGrouping).toEqual([
      "serviceType",
      "state",
      "district",
    ]);
    expect(manifest.fixedColumns).toEqual([
      "Polygon Start Date",
      "Polygon Name",
      "Capacity (Mbps)",
      "Rate/Mbps (MYR)",
      "Utilised Capacity Charges (MYR)",
    ]);
  });

  it("is what layoutFilesFromVerified parses (the seeded layout loads)", () => {
    expect(Object.keys(layout.manifest.sections)).toHaveLength(8);
  });

  it("rejects a usageAnnex or notes section, a column key, a missing section or another grouping", () => {
    const sections = seeded.sections as Record<string, unknown>;
    const { payment: _payment, ...withoutPayment } = sections;
    const rejected = [
      {
        ...seeded,
        sections: { ...sections, usageAnnex: { mandatory: false } },
      },
      { ...seeded, sections: { ...sections, notes: { mandatory: false } } },
      { ...seeded, sections: withoutPayment },
      { ...seeded, columns: { showUdrCount: { mandatory: false } } },
      { ...seeded, usageGrouping: ["state", "district"] },
      { ...seeded, fixedColumns: ["#", "Description"] },
    ];
    for (const manifest of rejected) {
      expect(layoutManifestSchema.safeParse(manifest).success).toBe(false);
    }
  });
});

describe("generate — TEMPLATE_GENERATION_FAILED", () => {
  it("rejects a nested [[if]]", () => {
    expectGenerationFailed(
      () =>
        generate(
          withPartial(
            "payment",
            "[[if sections.payment]]a[[if sections.payment]]b[[/if]][[/if]]",
          ),
          ALL_ON,
        ),
      "partials/payment.hbs",
    );
  });

  it("rejects an unknown directive", () => {
    expectGenerationFailed(
      () => generate(withPartial("payment", "[[else]]"), ALL_ON),
      "partials/payment.hbs",
    );
  });

  it("rejects an unknown key, a mandatory section key, and the retired columns/num directives", () => {
    for (const source of [
      "[[if sections.accountSummary]]x[[/if]]",
      "[[if sections.usageAnnex]]x[[/if]]",
      "[[if sections.notes]]x[[/if]]",
      "[[if sections.billTo]]x[[/if]]",
      "[[if columns.showUdrCount]]x[[/if]]",
      "[[num colCount]]",
      "[[num rowCount]]",
    ]) {
      expectGenerationFailed(
        () => generate(withPartial("payment", source), ALL_ON),
        "partials/payment.hbs",
      );
    }
  });

  it("rejects an unbalanced [[if]]", () => {
    expectGenerationFailed(
      () =>
        generate(withPartial("payment", "[[if sections.payment]]x"), ALL_ON),
      "partials/payment.hbs",
    );
    expectGenerationFailed(
      () => generate(withPartial("payment", "x[[/if]]"), ALL_ON),
      "partials/payment.hbs",
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
      () => generate(withPartial("payment", "[[body]]"), ALL_ON),
      "partials/payment.hbs",
    );
  });

  it("rejects a [[body]] hidden inside a false [[if]] block", () => {
    expectGenerationFailed(
      () =>
        generate(
          {
            ...layout,
            shell: layout.shell.replace(
              "[[body]]",
              "[[if sections.payment]][[body]][[/if]]",
            ),
          },
          structureFor(0),
        ),
      "shell.hbs",
    );
  });

  it("rejects a [[num]] name that is only an Object.prototype key", () => {
    expectGenerationFailed(
      () => generate(withPartial("payment", "[[num constructor]]"), ALL_ON),
      "partials/payment.hbs",
    );
  });

  it("rejects output that still carries a directive bracket", () => {
    expectGenerationFailed(
      () => generate(withPartial("payment", "<p>[[ unterminated</p>"), ALL_ON),
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
      '<span class="ph" data-ph="money this.utilised">{{money this.utilised}}</span>',
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
    expect(Object.keys(parsed)).toEqual(["columns", "footnote", "sections"]);
    // Footnote lines keep their order (an array is never sorted).
    expect(parsed.footnote).toEqual(FOOTNOTE);
    expect(structureJson).toBe(
      `${JSON.stringify(
        {
          columns: {},
          footnote: FOOTNOTE,
          sections: { payment: true },
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
