import { db } from "@/db/client";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { resolvePageSize } from "@/services/product/resolve-page-size";
import type { FamilyPage } from "@/types/product";
import type { FamilyListSearchParams } from "@/validation/product/family-list.schema";

// Backs the Manage Products families list (pm39 I3). `params` is the already-
// parsed `validation/product/family-list.schema` output — this service never
// touches raw searchParams (general §1.5). `params.family`/`params.version` are
// selection state, irrelevant to the list — ignored here (pm40 consumes them).
// Framework-agnostic: no `next/*`, a `FamilyPage` read model out (§2.2).
export async function listFamilies(
  params: FamilyListSearchParams,
): Promise<FamilyPage> {
  const pageSize = await resolvePageSize();

  const { rows, total } = await productOfferingRepository.findFamilyPage(db, {
    q: params.q,
    status: params.status,
    page: params.page,
    pageSize,
  });

  return { rows, total, page: params.page, pageSize };
}
