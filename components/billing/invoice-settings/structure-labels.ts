// bm58-spec §Design D4: the display labels for the template structure's
// sections, shared by the editor form and the Activate dialog's "what
// changes" summary so the two can never disagree. Display order follows the
// layout (`INVTPL-STD-A4` manifest order). A plain module, no JSX. bm71 (D56)
// removed the Usage annex row and the column toggles with the old line table.

import {
  INVOICE_OPTIONAL_SECTION_KEYS,
  type InvoiceOptionalSectionKey,
  type InvoiceSectionKey,
  type InvoiceTemplateStructure,
} from "@/types/billing";

export const SECTION_ROWS: { key: InvoiceSectionKey; label: string }[] = [
  { key: "identification", label: "Invoice identification" },
  { key: "billTo", label: "Bill-to" },
  { key: "amountDue", label: "Amount due" },
  { key: "chargeSummary", label: "Summary of charges" },
  { key: "taxSummary", label: "Tax summary" },
  { key: "chargeDetails", label: "Charge details" },
  { key: "payment", label: "Payment information" },
  { key: "notes", label: "Notes & terms" },
];

export interface StructureChange {
  // `+` something becomes shown, `−` something becomes hidden.
  sign: "+" | "−";
  text: string;
}

// The optional sections whose visibility differs between two structures, in
// display order: `+ Notes & terms shown`, `− Payment information hidden`. An
// empty result means "No change in structure" (a re-activation is still a
// legitimate audited event). Mandatory sections are always shown.
export function describeStructureChanges(
  before: InvoiceTemplateStructure,
  after: InvoiceTemplateStructure,
): StructureChange[] {
  const changes: StructureChange[] = [];
  for (const { key, label } of SECTION_ROWS) {
    if (!isOptionalSection(key)) continue;
    if (before.sections[key] !== after.sections[key]) {
      changes.push(
        after.sections[key]
          ? { sign: "+", text: `${label} shown` }
          : { sign: "−", text: `${label} hidden` },
      );
    }
  }
  return changes;
}

export function isOptionalSection(
  key: InvoiceSectionKey,
): key is InvoiceOptionalSectionKey {
  return (INVOICE_OPTIONAL_SECTION_KEYS as readonly string[]).includes(key);
}
