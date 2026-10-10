// bm58-spec §Design D4: the display labels for the template structure's
// sections and columns, shared by the editor form and the Activate dialog's
// "what changes" summary so the two can never disagree. Display order follows
// the layout (`INVTPL-STD-A4` manifest order). A plain module, no JSX.

import type {
  InvoiceColumnKey,
  InvoiceSectionKey,
  InvoiceTemplateStructure,
} from "@/types/billing";

export const SECTION_ROWS: { key: InvoiceSectionKey; label: string }[] = [
  { key: "identification", label: "Invoice identification" },
  { key: "billTo", label: "Bill-to" },
  { key: "amountDue", label: "Amount due" },
  { key: "chargeSummary", label: "Summary of charges" },
  { key: "taxSummary", label: "Tax summary" },
  { key: "chargeDetails", label: "Charge details" },
  { key: "payment", label: "Payment information" },
  { key: "usageAnnex", label: "Usage annex" },
  { key: "notes", label: "Notes & terms" },
];

export const COLUMN_LABELS: Record<InvoiceColumnKey, string> = {
  showServicePeriod: "Service period",
  showDiscountColumn: "Discount",
  showProductId: "Product offering ID",
  showUdrCount: "UDR type & count",
};

export interface StructureChange {
  // `+` something becomes shown, `−` something becomes hidden.
  sign: "+" | "−";
  text: string;
}

// The sections/columns whose visibility differs between two structures, in
// display order: `+ Usage annex shown`, `− Discount column hidden`. An empty
// result means "No change in structure" (a re-activation is still a legitimate
// audited event).
export function describeStructureChanges(
  before: InvoiceTemplateStructure,
  after: InvoiceTemplateStructure,
): StructureChange[] {
  const changes: StructureChange[] = [];
  for (const { key, label } of SECTION_ROWS) {
    if (before.sections[key] !== after.sections[key]) {
      changes.push(
        after.sections[key]
          ? { sign: "+", text: `${label} shown` }
          : { sign: "−", text: `${label} hidden` },
      );
    }
  }
  for (const key of Object.keys(COLUMN_LABELS) as InvoiceColumnKey[]) {
    if (before.columns[key] !== after.columns[key]) {
      const label = `${COLUMN_LABELS[key]} column`;
      changes.push(
        after.columns[key]
          ? { sign: "+", text: `${label} shown` }
          : { sign: "−", text: `${label} hidden` },
      );
    }
  }
  return changes;
}
