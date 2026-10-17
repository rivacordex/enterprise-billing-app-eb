// bm58-spec §Design D4: the display labels for the template structure's
// sections, shared by the editor form and the Activate dialog's "what
// changes" summary so the two can never disagree. Display order follows the
// layout (`INVTPL-STD-A4` manifest order). A plain module, no JSX. bm71 (D56)
// removed the Usage annex row and the column toggles with the old line table;
// bm72 (D56 part 2) removed Notes & terms, leaving Payment information as the
// only optional row, and added the footnote lines to the summary.

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
];

// One line of the Activate dialog's summary (ui-context §10b Phase 3 row):
//   - a section: `+ Payment information shown` / `− Payment information hidden`;
//   - a footnote line, compared by position (line numbers are 1-based):
//     `Footnote line 2: "old" → "new"`, `Footnote line 3 added: "…"`,
//     `Footnote line 3 removed`.
export type StructureChange =
  | { kind: "section"; sign: "+" | "−"; text: string }
  | { kind: "footnote-changed"; line: number; before: string; after: string }
  | { kind: "footnote-added"; line: number; after: string }
  | { kind: "footnote-removed"; line: number };

// What differs between the structure in use (`before`) and the draft
// (`after`): the optional sections in display order, then the footnote lines
// in line order. An empty result means "No change in structure." (a
// re-activation is still a legitimate audited event). Mandatory sections are
// always shown.
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
          ? { kind: "section", sign: "+", text: `${label} shown` }
          : { kind: "section", sign: "−", text: `${label} hidden` },
      );
    }
  }
  const lines = Math.max(before.footnote.length, after.footnote.length);
  for (let i = 0; i < lines; i++) {
    const old = before.footnote[i];
    const next = after.footnote[i];
    const line = i + 1;
    if (old === undefined && next !== undefined) {
      changes.push({ kind: "footnote-added", line, after: next });
    } else if (old !== undefined && next === undefined) {
      changes.push({ kind: "footnote-removed", line });
    } else if (old !== undefined && next !== undefined && old !== next) {
      changes.push({
        kind: "footnote-changed",
        line,
        before: old,
        after: next,
      });
    }
  }
  return changes;
}

export function isOptionalSection(
  key: InvoiceSectionKey,
): key is InvoiceOptionalSectionKey {
  return (INVOICE_OPTIONAL_SECTION_KEYS as readonly string[]).includes(key);
}
