import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";

// bm81 — moved from `services/billing/read/invoice-template-settings.ts`
// (behaviour unchanged) so the export service applies the page's rule.
//
// A version the page may show: a stored generated version, or a draft for an
// EDIT user (bm57 D4). Review fix (bm79) — a discarded draft (RETIRED, never
// activated) has no files and is still a draft: only EDIT users may open it,
// and it is never a stored version (no file download, no Generated files).
export function isDraftLike(row: BillTemplateVersion): boolean {
  return row.status === "DRAFT" || row.activatedDatetime === null;
}

export function isShowable(
  row: BillTemplateVersion | null,
  canEdit: boolean,
): row is BillTemplateVersion {
  return (
    row !== null && row.kind === "generated" && (!isDraftLike(row) || canEdit)
  );
}
