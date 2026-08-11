import type { Metadata } from "next";
import { Suspense } from "react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { OrdersTable } from "@/components/products/ordering/orders-table";
import { listOrders } from "@/services/ordering/list-orders";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { ordersListSearchParamsSchema } from "@/validation/ordering/orders-list.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Orders — Enterprise Billing",
};

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.PRODUCT_ORDERS, LEVELS.READ);

  const raw = await searchParams;
  // Lenient parse (pm27-spec — same discipline as offering-list.schema): a
  // tampered URL renders the default view and never 500s.
  const parsed = ordersListSearchParamsSchema.parse({
    q: firstValue(raw.q),
    status: firstValue(raw.status) ?? null,
    sort: firstValue(raw.sort),
    page: firstValue(raw.page) ?? 1,
    order: firstValue(raw.order) ?? null,
  });

  const timezone = getAppTimezone(); // sync accessor — outside Promise.all
  const [orderPage, locale] = await Promise.all([
    listOrders(parsed),
    getAppLocale(),
  ]);

  return (
    <main className="space-y-5 p-5">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">Orders</h1>
      </header>

      <Suspense>
        <OrdersTable
          rows={orderPage.rows}
          total={orderPage.total}
          page={orderPage.page}
          pageSize={orderPage.pageSize}
          selectedOrderId={parsed.order}
          query={parsed.q}
          status={parsed.status}
          sort={parsed.sort}
          locale={locale}
          timezone={timezone}
        />
      </Suspense>
    </main>
  );
}
