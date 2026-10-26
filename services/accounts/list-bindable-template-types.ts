// cm23 (code-standards §10 TS rule 2, custmgmt Inv. #22) — the options of the
// Manage Customer type select: Standard (null) first, then usable types by
// name. Read through Billing's type repository, never a Billing service.
// Retired and not-yet-usable types are absent (listUsable's filter).

import { db } from "@/db/client";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { STANDARD_TYPE_NAME } from "@/types/accounts";
import type { BindableTemplateType } from "@/types/accounts";

export async function listBindableTemplateTypes(): Promise<
  BindableTemplateType[]
> {
  const usable = await billTemplateFamilyRepository.listUsable(db);
  return [
    { typeId: null, name: STANDARD_TYPE_NAME },
    ...usable.map((t) => ({ typeId: t.billTemplateFamilyId, name: t.name })),
  ];
}
