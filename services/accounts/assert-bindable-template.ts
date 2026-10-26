import type { Database } from "@/db/client";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";

// cm23 (Inv. #19, #20; code-standards §10 General rules 1–3) — the single gate for any
// value written to billing_account.ref_bill_template_family_id. null (Standard) needs no
// lock. A type id is locked FOR SHARE in the CALLER's transaction before it is judged, so
// the bind and a retire (FOR UPDATE) serialise; never opens its own transaction.
// Shared by onboardCustomerAccounts (always null) and setBillingAccountTemplate.
export type AssertBindableTemplateResult =
  | { ok: true; typeName: string | null }
  | { ok: false; code: "TEMPLATE_NOT_BINDABLE" };

export async function assertBindableTemplate(
  tx: Database,
  typeId: string | null,
): Promise<AssertBindableTemplateResult> {
  if (typeId === null) return { ok: true, typeName: null };
  const type = await billTemplateFamilyRepository.lockTemplateType(
    tx,
    typeId,
    "share",
  );
  // `isDefault` is a column read, not an id comparison (General rule 1):
  // Standard is stored only as NULL, so its explicit id is refused.
  if (!type || type.isDefault || type.retiredDatetime !== null) {
    return { ok: false, code: "TEMPLATE_NOT_BINDABLE" };
  }
  const active = await billTemplateVersionRepository.findActive(tx, {
    kind: "generated",
    familyId: typeId,
  });
  return active
    ? { ok: true, typeName: type.name }
    : { ok: false, code: "TEMPLATE_NOT_BINDABLE" };
}
