import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// `load.ts` (PROBE_RENDER_INPUT) imports the blob store; serve the repo bytes
// instead, so no environment config is needed.
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
import { PROBE_RENDER_INPUT } from "@/services/billing/invoice-template/load";
import { parseSampleData } from "@/services/billing/invoice-template/sample-data";
import type { InvoiceRenderInput } from "@/types/billing";

// bm47-spec §Tests (overview success criterion 12) — delivered by the bm63
// sweep: a golden-render STRUCTURAL snapshot per layout version. The layout's
// own `sample-data.json` is executed through the default generated template
// that layout ships with (the immutable seeded bytes), and the HTML is
// compared with a committed file under `tests/fixtures/invoice-golden/`.
// `@font-face` source data is stubbed out and whitespace normalised, so the
// snapshot pins the markup, not font bytes or indentation. A new layout
// version adds its own directory here and gets its own golden file.
const SEEDS = join(__dirname, "../../../db/seeds/invoice-templates");
const GOLDEN = join(__dirname, "../../fixtures/invoice-golden");

// layout code/version → the default generated version rendered from it.
const LAYOUT_VERSIONS = [
  { layout: "INVTPL-STD-A4", version: "v1", generated: "generated/INVOICE/v1" },
] as const;

function normalise(html: string): string {
  // Data URIs first: an embedded font's `src: url(data:font/woff2;base64,…)`
  // has a `;` inside it, which would stop the `src:` strip early (bm70). The
  // stub is a valid `src` value so the golden file stays parseable CSS (Sonar
  // css:S4654 flags a bare placeholder as an unknown descriptor value).
  return html
    .replace(
      /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,
      "data:<stripped>",
    )
    .replace(/(@font-face\s*\{[^}]*?src:)[^;}]*/g, '$1 local("stripped")')
    .replace(/>\s+</g, ">\n<")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim()
    .concat("\n");
}

describe("golden render per layout version (criterion 12)", () => {
  it("covers every seeded layout version", () => {
    const seeded = readdirSync(join(SEEDS, "INVTPL-STD-A4"));
    expect(LAYOUT_VERSIONS.map((l) => l.version).sort()).toEqual(seeded.sort());
  });

  it.each(LAYOUT_VERSIONS)(
    "$layout $version renders its sample data to the golden HTML",
    async ({ layout, version, generated }) => {
      const sample = parseSampleData(
        new Map([
          [
            "sample-data.json",
            readFileSync(join(SEEDS, layout, version, "sample-data.json")),
          ],
        ]),
      );
      const tpl = (file: string) =>
        compileInvoiceTemplate(
          readFileSync(join(SEEDS, generated, file), "utf8"),
        );
      const html = executeInvoiceTemplate(tpl("invoice.hbs"), sample);
      const footer = executeInvoiceTemplate(tpl("footer.hbs"), sample);

      await expect(normalise(html)).toMatchFileSnapshot(
        join(GOLDEN, `${layout}-${version}.html`),
      );
      await expect(normalise(footer)).toMatchFileSnapshot(
        join(GOLDEN, `${layout}-${version}.footer.html`),
      );
    },
  );

  // The live preview renders the sample (which carries an invoice number)
  // as a draft: its <title> must say pro-forma, never "Tax invoice".
  it.each(LAYOUT_VERSIONS)(
    "$layout $version titles a draft pro-forma even when it carries a number",
    ({ layout, version, generated }) => {
      const sample = parseSampleData(
        new Map([
          [
            "sample-data.json",
            readFileSync(join(SEEDS, layout, version, "sample-data.json")),
          ],
        ]),
      );
      const tpl = compileInvoiceTemplate(
        readFileSync(join(SEEDS, generated, "invoice.hbs"), "utf8"),
      );
      const title = (isDraft: boolean) =>
        /<title>([^<]*)<\/title>/.exec(
          executeInvoiceTemplate(tpl, {
            ...sample,
            isDraft,
            invoice: { ...sample.invoice, isDraft },
          }),
        )?.[1];
      expect(sample.invoice.number).not.toBeNull();
      expect(title(true)).toBe("Pro-forma invoice");
      expect(title(false)).toBe(`Tax invoice ${sample.invoice.number}`);
    },
  );
});

// bm70-spec §6 — the rewritten v1 page 1 (D60), structurally: section order,
// one block per type of service, Other charges present or absent, the Grand
// Total panel and the amount-due line; and the supplier block from the
// captured Company Profile (types plan D102).
describe("layout v1 page 1 (bm70)", () => {
  const SEEDED_INVOICE = compileInvoiceTemplate(
    readFileSync(join(SEEDS, "generated/INVOICE/v1/invoice.hbs"), "utf8"),
  );
  const render = (input: InvoiceRenderInput) =>
    executeInvoiceTemplate(SEEDED_INVOICE, input);
  const sample = parseSampleData(
    new Map([
      [
        "sample-data.json",
        readFileSync(join(SEEDS, "INVTPL-STD-A4/v1/sample-data.json")),
      ],
    ]),
  );
  const sectionOrder = (html: string) =>
    [...html.matchAll(/class="sec sec--([A-Za-z]+) /g)].map((m) => m[1]);

  it("orders the sections header → identification → billTo → chargeSummary → taxSummary → amountDue → payment → chargeDetails → notes", () => {
    expect(sectionOrder(render(sample))).toEqual([
      "header",
      "identification",
      "billTo",
      "chargeSummary",
      "taxSummary",
      "amountDue",
      "payment",
      "chargeDetails",
      "notes",
    ]);
  });

  it("prints one Utilised / Unutilised / Total block per type of service, in order", () => {
    const html = render(sample);
    const headings = [
      ...html.matchAll(/<p class="svc-heading">([^<]*)<\/p>/g),
    ].map((m) => m[1]);
    expect(headings).toEqual([
      "5G RAN Target Capacity",
      "RAN Usage — Target Capacity",
      "Other charges",
    ]);
    expect(html.match(/Utilised capacity charges/g)).toHaveLength(2);
    expect(html.match(/Unutilised capacity charges/g)).toHaveLength(2);
    expect(html).toContain("Sub Total");
    expect(html).toContain("Total charges");
    expect(html).toContain("Adjustments");
    expect(html).toContain("Tax @ 0%");
  });

  it("omits the Other charges block when there are none", () => {
    const html = render({ ...sample, otherCharges: [] });
    expect(html).not.toContain('class="svc-block other-charges"');
    expect(html).not.toContain("Sub Total");
    expect(html).toContain("Total charges");
  });

  it("prints the Grand Total panel and the current-charges-only line; a draft reads indicative", () => {
    const issued = render(sample);
    expect(issued).toContain('class="grand-total-panel"');
    expect(issued).toContain("<span>Grand Total</span>");
    expect(issued).toContain(
      "Amount due covers the current charges on this invoice only.",
    );
    const draft = render({
      ...sample,
      isDraft: true,
      invoice: { ...sample.invoice, isDraft: true },
    });
    expect(draft).toContain("Grand Total (indicative)");
  });

  it("prints the recipient line only when the recipient name is set", () => {
    expect(render(sample)).toContain(
      '<div class="recipient">Aisha Rahman</div>',
    );
    expect(
      render({
        ...sample,
        customer: { ...sample.customer, recipientName: null },
      }),
    ).not.toContain('class="recipient"');
  });

  it("D102 — the header prints the supplier block from the captured profile", () => {
    const html = render(PROBE_RENDER_INPUT);
    const header = html.slice(
      html.indexOf("sec--header"),
      html.indexOf("sec--identification"),
    );
    const c = PROBE_RENDER_INPUT.company!;
    for (const text of [
      c.name,
      `Reg. No. ${c.registrationNo}`,
      `TIN ${c.tin}`,
      c.addressLine1,
      c.addressLine2!,
      `${c.postcode} ${c.city}`,
      c.state,
      c.country,
      c.phone,
      c.email,
    ]) {
      expect(header).toContain(text);
    }
    expect(header).toContain(`SST No. ${c.sstRegNo}`);
  });

  it("D102 — the SST line is absent when the profile has no SST number", () => {
    const noSst: InvoiceRenderInput = {
      ...PROBE_RENDER_INPUT,
      company: { ...PROBE_RENDER_INPUT.company!, sstRegNo: null },
    };
    expect(render(noSst)).not.toContain("SST No.");
  });
});
