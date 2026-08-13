import { db } from "@/db/client";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import type { SubscriptionListPage } from "@/types/inventory";
import type { SubscriptionsListSearchParams } from "@/validation/inventory/subscriptions-list.schema";

// Fixed page size (orders-list precedent, pm26) — no per-request
// configurability yet.
export const SUBSCRIPTIONS_LIST_PAGE_SIZE = 20;

// Backs the subscriptions list. `params` is the already-parsed
// `validation/inventory/subscriptions-list.schema` output — this service
// never touches raw searchParams (general §1.5). `params.subscription` is
// selection state, irrelevant to the list — ignored here. Framework-agnostic:
// no `next/*`.
export async function listSubscriptions(
  params: SubscriptionsListSearchParams,
): Promise<SubscriptionListPage> {
  const { rows, total } = await productInventoryRepository.findList(db, {
    q: params.q,
    status: params.status,
    sort: params.sort,
    page: params.page,
    pageSize: SUBSCRIPTIONS_LIST_PAGE_SIZE,
  });

  return {
    rows,
    total,
    page: params.page,
    pageSize: SUBSCRIPTIONS_LIST_PAGE_SIZE,
  };
}
