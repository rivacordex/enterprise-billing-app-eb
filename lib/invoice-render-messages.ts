import type { InvoiceErrorCode } from "@/types/billing";

// bm66-spec §Design "Render errors reach the user with their code" (UI context
// §10d) — the user-facing message for a render failure's `InvoiceErrorCode`,
// computed by the draft-invoice route for its 422 body and shown by
// `InvoicePreviewModal`. Codes without their own copy keep the generic text;
// bm70 and bm71 add theirs here.
//
// `TEMPLATE_VERSION_NOT_FOUND` covers several causes (a missing stamped row, a
// missing blob, a corrupted catalog). Only the D55 cause — the family had no
// ACTIVE version at run start (`detail.reason = FAMILY_HAS_NO_ACTIVE_VERSION`)
// — gets the "activate, then rerun" copy (§10d scopes it to that reason); any
// other cause keeps the generic text, because that advice would not fix it.
const GENERIC_RENDER_MESSAGE =
  "Could not render the draft invoice. Please try again.";

export const FAMILY_HAS_NO_ACTIVE_VERSION = "FAMILY_HAS_NO_ACTIVE_VERSION";

export function describeInvoiceRenderCode(
  code: InvoiceErrorCode,
  reason?: unknown,
): string {
  switch (code) {
    case "TEMPLATE_VERSION_NOT_FOUND":
      return reason === FAMILY_HAS_NO_ACTIVE_VERSION
        ? "This account's invoice template has no active version. Activate one in Invoice Settings, then rerun this account."
        : GENERIC_RENDER_MESSAGE;
    case "INVOICE_RECONCILIATION_FAILED":
      return "The invoice lines do not add up to the bill total. Rerun this account; if it repeats, report it.";
    case "INVOICE_USAGE_OVER_LIMIT":
      return "This account has more than 10,000 billed usage records, over the invoice limit.";
    case "INVOICE_NEGATIVE_UTILISED":
      return "Utilised capacity charges came out negative. Check the rate-matching setting and rerun this account.";
    default:
      return GENERIC_RENDER_MESSAGE;
  }
}
