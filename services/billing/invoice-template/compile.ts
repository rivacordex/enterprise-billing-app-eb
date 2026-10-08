import Handlebars from "handlebars";

import { KNOWN_HELPERS, registerInvoiceHelpers } from "@/services/billing/invoice-template/helpers";
import { InvoiceRenderError } from "@/types/billing";
import type { InvoiceRenderInput } from "@/types/billing";

// bm47-spec §Design D6 (Inv #46) — Handlebars runs in an isolated env, never
// the global instance, with exactly the nine helpers registered once at
// module load. Partials are never registered at runtime: the generated
// `invoice.hbs` is self-contained (D8), so `{{> }}` never appears here.
const hb = Handlebars.create();
registerInvoiceHelpers(hb);

export function compileInvoiceTemplate(
  source: string,
): HandlebarsTemplateDelegate<InvoiceRenderInput> {
  try {
    return hb.compile<InvoiceRenderInput>(source, {
      knownHelpers: KNOWN_HELPERS,
      knownHelpersOnly: true,
      strict: true,
      noEscape: false,
    });
  } catch (err) {
    throw new InvoiceRenderError(
      "TEMPLATE_COMPILE_FAILED",
      err instanceof Error ? err.message : "template compile failed",
    );
  }
}

// A compiled template throws Handlebars' own `Error` (strict-mode miss, a
// runtime helper failure) rather than an `InvoiceRenderError` — D10 wraps
// that at the call site, not here, so the distinction between a compile-time
// failure (this file) and an execute-time failure (the caller) stays clear.
export function executeInvoiceTemplate(
  template: HandlebarsTemplateDelegate<InvoiceRenderInput>,
  input: InvoiceRenderInput,
): string {
  try {
    return template(input);
  } catch (err) {
    if (err instanceof InvoiceRenderError) throw err;
    throw new InvoiceRenderError(
      "TEMPLATE_COMPILE_FAILED",
      err instanceof Error ? err.message : "template execution failed",
    );
  }
}
