import type { Database } from "@/db/client";

// cm18 (custmgmt Inv. #18, binding plan D13/D15) — the single gate for any
// value written to billing_account.ref_bill_template_version_id. v1 accepts
// NULL only ("follow the active template"); a non-NULL id is rejected until
// Phase 3 lifts this rule together with the posting change (plan §9 tripwire).
// Shared by onboardCustomerAccounts (cm18) and setBillingAccountTemplate (cm21).
export type AssertBindableTemplateResult =
  | { ok: true }
  | { ok: false; code: "TEMPLATE_NOT_BINDABLE" };

export async function assertBindableTemplate(
  _tx: Database,
  billTemplateVersionId: string | null,
): Promise<AssertBindableTemplateResult> {
  if (billTemplateVersionId === null) return { ok: true };
  return { ok: false, code: "TEMPLATE_NOT_BINDABLE" };
}
