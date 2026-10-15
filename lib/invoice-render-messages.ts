import type { InvoiceErrorCode } from "@/types/billing";

// bm66-spec §Design "Render errors reach the user with their code" (UI context
// §10d) — the user-facing message for a render failure's `InvoiceErrorCode`,
// shared by the draft-invoice route's 422 body and `InvoicePreviewModal`.
// Codes without their own copy keep the generic text; bm70 and bm71 add
// theirs here.
const GENERIC_RENDER_MESSAGE =
  "Could not render the draft invoice. Please try again.";

export function describeInvoiceRenderCode(code: InvoiceErrorCode): string {
  switch (code) {
    case "TEMPLATE_VERSION_NOT_FOUND":
      return "This account's invoice template has no active version. Activate one in Invoice Settings, then rerun this account.";
    case "INVOICE_RECONCILIATION_FAILED":
      return "The invoice lines do not add up to the bill total. Rerun this account; if it repeats, report it.";
    case "INVOICE_USAGE_OVER_LIMIT":
      return "This account has more than 10,000 billed usage records, over the invoice limit.";
    default:
      return GENERIC_RENDER_MESSAGE;
  }
}
