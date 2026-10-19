import { describe, expect, it } from "vitest";

import {
  SECTION_ROWS,
  describeStructureChanges,
} from "@/components/billing/invoice-settings/structure-labels";
import type { InvoiceTemplateStructure } from "@/types/billing";

// bm58-spec §Design D4: the Activate dialog's "what changes" summary lists the
// optional sections whose visibility differs from the structure in use, in the
// layout's display order, and nothing when they match. bm71 (D56): the Usage
// annex row and the column toggles are gone. bm72 (D56 part 2): Notes & terms
// is gone, and each footnote line that differs is listed, by position.

const BASE: InvoiceTemplateStructure = {
  sections: { payment: true },
  columns: {},
  footnote: ["Calculations are done in Mbps", "Exclusive of USP"],
};

describe("describeStructureChanges", () => {
  it("is empty when the structures match", () => {
    expect(describeStructureChanges(BASE, BASE)).toEqual([]);
  });

  it("lists a shown or hidden Payment section with a sign", () => {
    const hidden: InvoiceTemplateStructure = {
      ...BASE,
      sections: { payment: false },
    };
    expect(describeStructureChanges(BASE, hidden)).toEqual([
      { kind: "section", sign: "−", text: "Payment information hidden" },
    ]);
    expect(describeStructureChanges(hidden, BASE)).toEqual([
      { kind: "section", sign: "+", text: "Payment information shown" },
    ]);
  });

  it("lists a changed footnote line with its old and new text", () => {
    const after = {
      ...BASE,
      footnote: [BASE.footnote[0]!, "Inclusive of USP"],
    };
    expect(describeStructureChanges(BASE, after)).toEqual([
      {
        kind: "footnote-changed",
        line: 2,
        before: "Exclusive of USP",
        after: "Inclusive of USP",
      },
    ]);
  });

  it("lists added and removed footnote lines by position", () => {
    const added = { ...BASE, footnote: [...BASE.footnote, "Third line"] };
    expect(describeStructureChanges(BASE, added)).toEqual([
      { kind: "footnote-added", line: 3, after: "Third line" },
    ]);
    expect(describeStructureChanges(added, BASE)).toEqual([
      { kind: "footnote-removed", line: 3 },
    ]);
  });

  it("lists the section change first, then the footnote lines in order", () => {
    const after: InvoiceTemplateStructure = {
      sections: { payment: false },
      columns: {},
      footnote: ["Line one changed"],
    };
    expect(describeStructureChanges(BASE, after).map((c) => c.kind)).toEqual([
      "section",
      "footnote-changed",
      "footnote-removed",
    ]);
  });
});

describe("SECTION_ROWS (bm72)", () => {
  it("has Payment information as the only optional row, and no Notes or Usage annex row", () => {
    const labels = SECTION_ROWS.map((r) => r.label);
    expect(labels).not.toContain("Usage annex");
    expect(labels).not.toContain("Notes & terms");
    expect(SECTION_ROWS.map((r) => r.key)).toEqual([
      "identification",
      "billTo",
      "amountDue",
      "chargeSummary",
      "taxSummary",
      "chargeDetails",
      "payment",
    ]);
  });
});
