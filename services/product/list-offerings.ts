import { db } from "@/db/client";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import type { OfferingListPage } from "@/types/product";
import type { OfferingListSearchParams } from "@/validation/product/offering-list.schema";

export const DEFAULT_OFFERING_LIST_PAGE_SIZE = 5;

const PAGE_SIZE_REGEX = /^\d+$/;

// Design #8: runtime-configurable page size via `core.SYSTEM_CONFIG`
// (`products`/`offering_list_page_size`). Only a bare 1-100 integer string
// is accepted; anything else (missing, empty, non-numeric, out of range)
// falls back silently to the default — no caching, no per-request warn
// logging.
async function resolvePageSize(): Promise<number> {
  const raw = await systemConfigRepository.findActiveValue(
    db,
    "products",
    "offering_list_page_size",
  );
  if (raw === null || !PAGE_SIZE_REGEX.test(raw)) {
    return DEFAULT_OFFERING_LIST_PAGE_SIZE;
  }
  const value = Number(raw);
  if (value < 1 || value > 100) {
    return DEFAULT_OFFERING_LIST_PAGE_SIZE;
  }
  return value;
}

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
