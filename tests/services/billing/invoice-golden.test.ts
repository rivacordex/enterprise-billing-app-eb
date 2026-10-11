import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compileInvoiceTemplate,
  executeInvoiceTemplate,
} from "@/services/billing/invoice-template/compile";
import { parseSampleData } from "@/services/billing/invoice-template/sample-data";

// bm47-spec §Tests (overview success criterion 12) — delivered by the bm63
// sweep: a golden-render STRUCTURAL snapshot per layout version. The layout's
// own `sample-data.json` is executed through the default generated template
// that layout ships with (the immutable seeded bytes), and the HTML is
// compared with a committed file under `tests/fixtures/invoice-golden/`.
// `@font-face` source data is stripped and whitespace normalised, so the
// snapshot pins the markup, not font bytes or indentation. A new layout
// version adds its own directory here and gets its own golden file.
const SEEDS = join(__dirname, "../../../db/seeds/invoice-templates");
const GOLDEN = join(__dirname, "../../fixtures/invoice-golden");

// layout code/version → the default generated version rendered from it.
const LAYOUT_VERSIONS = [
  { layout: "INVTPL-STD-A4", version: "v1", generated: "generated/INVOICE/v1" },
] as const;

function normalise(html: string): string {
  return html
    .replace(/(@font-face\s*\{[^}]*?src:)[^;}]*/g, "$1 <stripped>")
    .replace(
      /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,
      "data:<stripped>",
    )
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
