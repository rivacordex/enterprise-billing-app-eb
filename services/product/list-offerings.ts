import { db } from "@/db/client";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { resolvePageSize } from "@/services/product/resolve-page-size";
import type { OfferingListPage } from "@/types/product";
import type { OfferingListSearchParams } from "@/validation/product/offering-list.schema";

// Re-exported for the existing consumers that imported it from here (pm39 D5
// extracted the implementation into resolve-page-size.ts; behaviour unchanged).
export { DEFAULT_OFFERING_LIST_PAGE_SIZE } from "@/services/product/resolve-page-size";

// Backs the offerings table (pm03-spec §3.5). `params` is the already-
// parsed `validation/product/offering-list.schema` output — this service
// never touches raw searchParams (general §1.5). `params.offering` is
// selection state, irrelevant to the list — ignored here.
export async function listOfferings(
  params: OfferingListSearchParams,
): Promise<OfferingListPage> {
  const pageSize = await resolvePageSize();

  const { rows, total } = await productOfferingRepository.findList(db, {
    q: params.q,
    status: params.status,
    sort: params.sort,
    page: params.page,
    pageSize,
  });

  return { rows, total, page: params.page, pageSize };
}
