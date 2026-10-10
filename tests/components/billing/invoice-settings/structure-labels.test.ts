import { describe, expect, it } from "vitest";

import { describeStructureChanges } from "@/components/billing/invoice-settings/structure-labels";
import type { InvoiceTemplateStructure } from "@/types/billing";

// bm58-spec §Design D4: the Activate dialog's "what changes" summary lists the
// sections/columns whose visibility differs from the structure in use, in the
// layout's display order, and nothing when they match.

const BASE: InvoiceTemplateStructure = {
  sections: {
    billTo: true,
    identification: true,
    amountDue: true,
    chargeSummary: true,
    taxSummary: true,
    payment: true,
    chargeDetails: true,
    usageAnnex: true,
    notes: true,
  },
  columns: {
    showServicePeriod: true,
    showDiscountColumn: true,
    showProductId: true,
    showUdrCount: true,
  },
};

describe("describeStructureChanges", () => {
  it("is empty when the structures match", () => {
    expect(describeStructureChanges(BASE, BASE)).toEqual([]);
  });

  it("lists shown and hidden sections and columns with a sign", () => {
    const before: InvoiceTemplateStructure = {
      ...BASE,
      sections: { ...BASE.sections, usageAnnex: false },
    };
    const after: InvoiceTemplateStructure = {
      sections: { ...BASE.sections, usageAnnex: true, notes: false },
      columns: { ...BASE.columns, showDiscountColumn: false },
    };
    expect(describeStructureChanges(before, after)).toEqual([
      { sign: "+", text: "Usage annex shown" },
      { sign: "−", text: "Notes & terms hidden" },
      { sign: "−", text: "Discount column hidden" },
    ]);
  });

  it("orders sections in layout order, before columns", () => {
    const after: InvoiceTemplateStructure = {
      sections: { ...BASE.sections, notes: false, payment: false },
      columns: { ...BASE.columns, showServicePeriod: false },
    };
    expect(describeStructureChanges(BASE, after).map((c) => c.text)).toEqual([
      "Payment information hidden",
      "Notes & terms hidden",
      "Service period column hidden",
    ]);
  });
});
