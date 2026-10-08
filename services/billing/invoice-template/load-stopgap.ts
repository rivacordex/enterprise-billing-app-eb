// bm47-spec §Design D8 — STOPGAP. bm55 builds the real generator; until then
// this file reads the hand-written "generated" default output straight from
// the repo (bm50 freezes these bytes; bm55's parity test proves the
// hand-written file matches what the generator produces). DELETED IN BM53 —
// do not add a second caller or any export beyond `loadDefaultTemplateFromRepo`.
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  compileInvoiceTemplate,
  executeInvoiceTemplate,
} from "@/services/billing/invoice-template/compile";
import type { InvoiceRenderInput } from "@/types/billing";

const GENERATED_DIR = path.join(
  process.cwd(),
  "db/seeds/invoice-templates/generated/INVOICE/v1",
);

let cached: {
  template: HandlebarsTemplateDelegate<InvoiceRenderInput>;
  footerTemplate: HandlebarsTemplateDelegate<InvoiceRenderInput>;
} | null = null;

export async function loadDefaultTemplateFromRepo(): Promise<{
  render: (input: InvoiceRenderInput) => string;
  renderFooter: (input: InvoiceRenderInput) => string;
}> {
  if (!cached) {
    const [invoiceSource, footerSource] = await Promise.all([
      readFile(path.join(GENERATED_DIR, "invoice.hbs"), "utf-8"),
      readFile(path.join(GENERATED_DIR, "footer.hbs"), "utf-8"),
    ]);
    cached = {
      template: compileInvoiceTemplate(invoiceSource),
      footerTemplate: compileInvoiceTemplate(footerSource),
    };
  }
  const { template, footerTemplate } = cached;
  return {
    render: (input) => executeInvoiceTemplate(template, input),
    renderFooter: (input) => executeInvoiceTemplate(footerTemplate, input),
  };
}
