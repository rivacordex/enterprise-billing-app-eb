import type { LifecycleStatus } from "@/types/product";

export const MANAGE_PRODUCTS_PATH = "/products/manage-products";

// Single builder for every Manage Products URL — the families table (row links,
// pagination, clear/first-page links) and the version bar (version switch) both
// go through it so the two never drift on which searchParams are carried or how
// they're encoded. Empty/absent values are dropped and `page` is omitted at 1,
// so a link with no active state collapses to the bare path. Param order is
// fixed (q, status, page, family, version) to match the pm39 families-table
// output byte-for-byte. `family`/`version` are optional: the families table
// omits `version` (a fresh family selection resets to the primary, D1), while
// the version bar supplies both.
export function buildManageProductsHref(parts: {
  q?: string;
  status?: LifecycleStatus | null;
  page?: number;
  family?: string | null;
  version?: string | null;
}): string {
  const params = new URLSearchParams();
  if (parts.q) params.set("q", parts.q);
  if (parts.status) params.set("status", parts.status);
  if (parts.page && parts.page > 1) params.set("page", String(parts.page));
  if (parts.family) params.set("family", parts.family);
  if (parts.version) params.set("version", parts.version);
  const qs = params.toString();
  return qs ? `${MANAGE_PRODUCTS_PATH}?${qs}` : MANAGE_PRODUCTS_PATH;
}
