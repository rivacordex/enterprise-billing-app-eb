import { db } from "@/db/client";
import { productOrderRepository } from "@/db/repositories/ordering/product-order.repository";
import type { OrderListPage } from "@/types/ordering";
import type { OrdersListSearchParams } from "@/validation/ordering/orders-list.schema";

// Fixed page size for the orders list — no per-request configurability yet
// (unlike the catalog's SYSTEM_CONFIG-driven size); a plain module constant
// until a config surface is actually needed.
export const ORDERS_LIST_PAGE_SIZE = 20;

// Backs the orders list. `params` is the already-parsed
// `validation/ordering/orders-list.schema` output — this service never touches
// raw searchParams (general §1.5). `params.order` is selection state,
// irrelevant to the list — ignored here. Framework-agnostic: no `next/*`.
export async function listOrders(
  params: OrdersListSearchParams,
): Promise<OrderListPage> {
  const { rows, total } = await productOrderRepository.findList(db, {
    q: params.q,
    status: params.status,
    sort: params.sort,
    page: params.page,
    pageSize: ORDERS_LIST_PAGE_SIZE,
  });

  return { rows, total, page: params.page, pageSize: ORDERS_LIST_PAGE_SIZE };
}
