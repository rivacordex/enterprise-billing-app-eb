import { describe, expect, it } from "vitest";

import {
  SECTION_ROWS,
  describeStructureChanges,
} from "@/components/billing/invoice-settings/structure-labels";
import type { InvoiceTemplateStructure } from "@/types/billing";

// bm58-spec §Design D4: the Activate dialog's "what changes" summary lists the
// optional sections whose visibility differs from the structure in use, in the
// layout's display order, and nothing when they match. bm71 (D56): the Usage
// annex row and the column toggles are gone.

const BASE: InvoiceTemplateStructure = {
  sections: { payment: true, notes: true },
  columns: {},
};

describe("describeStructureChanges", () => {
  it("is empty when the structures match", () => {
    expect(describeStructureChanges(BASE, BASE)).toEqual([]);
  });

  it("lists shown and hidden sections with a sign", () => {
    const before: InvoiceTemplateStructure = {
      ...BASE,
      sections: { payment: false, notes: true },
    };
    const after: InvoiceTemplateStructure = {
      ...BASE,
      sections: { payment: true, notes: false },
    };
    expect(describeStructureChanges(before, after)).toEqual([
      { sign: "+", text: "Payment information shown" },
      { sign: "−", text: "Notes & terms hidden" },
    ]);
  });

  it("orders sections in layout order", () => {
    const after: InvoiceTemplateStructure = {
      ...BASE,
      sections: { notes: false, payment: false },
    };
    expect(describeStructureChanges(BASE, after).map((c) => c.text)).toEqual([
      "Payment information hidden",
      "Notes & terms hidden",
    ]);
  });
});

describe("SECTION_ROWS (bm71)", () => {
  it("has no Usage annex row", () => {
    expect(SECTION_ROWS.map((r) => r.label)).not.toContain("Usage annex");
    expect(SECTION_ROWS.map((r) => r.key)).toEqual([
      "identification",
      "billTo",
      "amountDue",
      "chargeSummary",
      "taxSummary",
      "chargeDetails",
      "payment",
      "notes",
    ]);
  });
});
