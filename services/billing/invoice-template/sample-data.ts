import { InvoiceRenderError, type InvoiceRenderInput } from "@/types/billing";

// The layout's verified `sample-data.json` as a render input. Shared by the
// live preview (bm55) and the activation test-render (bm58) so the sample
// contract is parsed, and validated if it ever gets validated, in one place.
export function parseSampleData(
  layoutFiles: ReadonlyMap<string, Buffer>,
): InvoiceRenderInput {
  try {
    const bytes = layoutFiles.get("sample-data.json");
    if (bytes === undefined) throw new Error("missing");
    return JSON.parse(bytes.toString("utf-8")) as InvoiceRenderInput;
  } catch {
    throw new InvoiceRenderError(
      "TEMPLATE_COMPILE_FAILED",
      "the layout's sample-data.json is missing or not valid JSON",
      { file: "sample-data.json" },
    );
  }
}
