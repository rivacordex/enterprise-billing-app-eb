import { db } from "@/db/client";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";

export const DEFAULT_OFFERING_LIST_PAGE_SIZE = 5;

const PAGE_SIZE_REGEX = /^\d+$/;

// Runtime-configurable page size via `core.SYSTEM_CONFIG`
// (`products`/`offering_list_page_size`). Only a bare 1-100 integer string is
// accepted; anything else (missing, empty, non-numeric, out of range) falls
// back silently to the default — no caching, no per-request warn logging.
// Shared by listOfferings (View Product) and listFamilies (Manage Products) so
// both surfaces read the one config key through the one code path (pm39 D5).
export async function resolvePageSize(): Promise<number> {
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
