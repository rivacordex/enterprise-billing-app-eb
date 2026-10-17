import { describe, expect, it } from "vitest";

import { describeInvoiceRenderCode } from "@/lib/invoice-render-messages";
import { INVOICE_ERROR_CODES } from "@/types/billing";

// bm66-spec §5 / UI context §10d — the shared render-failure message map used
// by the draft-invoice route's 422 body and InvoicePreviewModal.
const GENERIC = "Could not render the draft invoice. Please try again.";

describe("describeInvoiceRenderCode", () => {
  it("gives TEMPLATE_VERSION_NOT_FOUND the §10d no-active-version copy only for the D55 reason", () => {
    expect(
      describeInvoiceRenderCode(
        "TEMPLATE_VERSION_NOT_FOUND",
        "FAMILY_HAS_NO_ACTIVE_VERSION",
      ),
    ).toBe(
      "This account's invoice template has no active version. Activate one in Invoice Settings, then rerun this account.",
    );
  });

  it("review fix — any other TEMPLATE_VERSION_NOT_FOUND cause (missing blob, uncaptured row) keeps the generic text", () => {
    expect(describeInvoiceRenderCode("TEMPLATE_VERSION_NOT_FOUND")).toBe(
      GENERIC,
    );
    expect(
      describeInvoiceRenderCode(
        "TEMPLATE_VERSION_NOT_FOUND",
        "TEMPLATE_NOT_CAPTURED",
      ),
    ).toBe(GENERIC);
  });

  it("gives the reconciliation and usage-limit codes their own copy", () => {
    expect(describeInvoiceRenderCode("INVOICE_RECONCILIATION_FAILED")).toBe(
      "The invoice lines do not add up to the bill total. Rerun this account; if it repeats, report it.",
    );
    expect(describeInvoiceRenderCode("INVOICE_USAGE_OVER_LIMIT")).toBe(
      "This account has more than 10,000 billed usage records, over the invoice limit.",
    );
  });

  it("bm70 — gives INVOICE_NEGATIVE_UTILISED the §10d copy", () => {
    expect(describeInvoiceRenderCode("INVOICE_NEGATIVE_UTILISED")).toBe(
      "Utilised capacity charges came out negative. Check the rate-matching setting and rerun this account.",
    );
  });

  it("bm71 — INVOICE_POLYGON_DATA_MISSING has the UI context §10d copy", () => {
    expect(describeInvoiceRenderCode("INVOICE_POLYGON_DATA_MISSING")).toBe(
      "Polygon data is missing for a billed record (no polygon ID or region). Fix the rated data and rerun this account.",
    );
  });

  it("returns a non-empty message for every code, the generic text for the rest", () => {
    const specific = new Set([
      "INVOICE_RECONCILIATION_FAILED",
      "INVOICE_USAGE_OVER_LIMIT",
      "INVOICE_NEGATIVE_UTILISED",
      "INVOICE_POLYGON_DATA_MISSING",
    ]);
    for (const code of INVOICE_ERROR_CODES) {
      const message = describeInvoiceRenderCode(code);
      expect(message.length).toBeGreaterThan(0);
      if (!specific.has(code)) expect(message).toBe(GENERIC);
    }
  });
});
