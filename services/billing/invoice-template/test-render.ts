import {
  compileInvoiceTemplate,
  executeInvoiceTemplate,
} from "@/services/billing/invoice-template/compile";
import {
  PROBE_RENDER_INPUT,
  probeGeneratedTemplate,
} from "@/services/billing/invoice-template/load";
import { InvoiceRenderError, type InvoiceRenderInput } from "@/types/billing";

// bm58-spec §Design D2 step 5 — the activation test render. In its own module
// since bm79: activation now re-runs the upload gate (`checkLayoutFiles`),
// which itself calls `testRender`, and a shared module keeps the two files
// free of an import cycle. `activate-template.ts` re-exports it.

function testRenderFailed(message: string): InvoiceRenderError {
  return new InvoiceRenderError("TEMPLATE_COMPILE_FAILED", message, {
    stage: "test-render",
  });
}

// The three shapes every base input is rendered in: as a draft, as issued, and
// issued with no company or payment profile (the G15 path).
function variantsOf(base: InvoiceRenderInput): InvoiceRenderInput[] {
  const issued: InvoiceRenderInput = {
    ...base,
    isDraft: false,
    invoice: { ...base.invoice, isDraft: false },
  };
  return [
    { ...base, isDraft: true, invoice: { ...base.invoice, isDraft: true } },
    issued,
    { ...issued, company: null, payment: null },
  ];
}

// Step 5: compile both outputs fresh (never the memo), run the load-time probe
// itself (`probeGeneratedTemplate`, the exact gate `loadGenerated` runs — both
// gates must agree: a template that passed activation but failed the load
// probe would already be ACTIVE, and the previous version RETIRED, while every
// render of it parked), then execute `variantsOf` both the typed
// `PROBE_RENDER_INPUT` and the layout's verified sample bill. Handlebars
// compiles lazily, so executing is what surfaces an unknown helper or a
// strict-mode missing path.
export function testRender(
  invoiceHbs: string,
  footerHbs: string,
  sample: InvoiceRenderInput,
): void {
  const invoice = compileInvoiceTemplate(invoiceHbs);
  const footer = compileInvoiceTemplate(footerHbs);

  probeGeneratedTemplate(invoice, footer);
  const variants = [...variantsOf(PROBE_RENDER_INPUT), ...variantsOf(sample)];

  for (const input of variants) {
    const html = executeInvoiceTemplate(invoice, input);
    if (html.trim() === "")
      throw testRenderFailed("invoice.hbs rendered empty");
    if (html.includes("[[") || html.includes("]]")) {
      throw testRenderFailed(
        "invoice.hbs rendered an unresolved [[ ]] directive",
      );
    }
    const footerHtml = executeInvoiceTemplate(footer, input);
    if (footerHtml.trim() === "")
      throw testRenderFailed("footer.hbs rendered empty");
    if (
      !footerHtml.includes("pageNumber") ||
      !footerHtml.includes("totalPages")
    ) {
      throw testRenderFailed(
        "footer.hbs must carry the pageNumber and totalPages spans",
      );
    }
  }
}
