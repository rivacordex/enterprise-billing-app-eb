// cm20 (binding plan D11, custmgmt Inv. #18) — the customer-screen label for a
// BAN's invoice template reference. Live lookup, never cached or persisted,
// never presented as what a future bill will use. Mirrors the resolver's
// "current" rule (findActive ?? findDefault, kind generated) but does NOT call
// resolveTemplate/resolveVersionsForPosting.

import type { Database } from "@/db/client";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";

export const TEMPLATE_REFERENCE_NOT_SUPPORTED =
  "Template reference not supported yet";

// "INVTPL-STD-A4 v1"-style text: the layout code of the current generated
// version's layout, plus the generated version's number. The seeded catalog
// always has a default generated version (bm50), so the fallbacks below only
// guard a damaged catalog — the tab still renders.
export async function resolveCurrentTemplateLabel(
  db: Database,
): Promise<string> {
  const current =
    (await billTemplateVersionRepository.findActive(db, {
      kind: "generated",
    })) ??
    (await billTemplateVersionRepository.findDefault(db, {
      kind: "generated",
    }));
  if (current === null) return "unavailable";

  const layout =
    current.refLayoutVersionId === null
      ? null
      : await billTemplateVersionRepository.findById(
          db,
          current.refLayoutVersionId,
        );
  const name = layout?.layoutCode ?? current.billTemplateVersionId;
  return `${name} v${current.versionNo}`;
}

// v1 BANs are always NULL (cm18/cm21 reject anything else). A non-NULL value
// is never resolved here (Phase 3); the caller logs a warning.
export function banTemplateLabel(
  refBillTemplateVersionId: string | null,
  current: string,
): string {
  if (refBillTemplateVersionId !== null)
    return TEMPLATE_REFERENCE_NOT_SUPPORTED;
  return `Follows active template (currently: ${current}), as of now`;
}
