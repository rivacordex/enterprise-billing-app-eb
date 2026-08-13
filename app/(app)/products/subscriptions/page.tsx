import type { Metadata } from "next";
import { Suspense } from "react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { SubscriptionsTable } from "@/components/products/inventory/subscriptions-table";
import { getSubscriptionDetail } from "@/services/inventory/get-subscription-detail";
import { listSubscriptions } from "@/services/inventory/list-subscriptions";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { hasLevel } from "@/types/permissions";
import { subscriptionsListSearchParamsSchema } from "@/validation/inventory/subscriptions-list.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Subscriptions — Enterprise Billing",
};

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// pm33-spec §Implementation-1. Thin RSC orchestrator (orders/page.tsx
// precedent): guard product_inventory:READ -> parse searchParams (lenient,
// code-standards §3.3 — a tampered URL falls back to defaults, never 500s)
// -> listSubscriptions + getSubscriptionDetail for the `?subscription=`-
// selected row -> compose SubscriptionsTable. `canEdit` (EDIT level) is
// resolved once here and threaded down so the table never re-resolves
// permissions client-side.
export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { permissionMap } = await requirePermission(
    PERMISSIONS.PRODUCT_INVENTORY,
    LEVELS.READ,
  );
  const canEdit = hasLevel(
    permissionMap,
    PERMISSIONS.PRODUCT_INVENTORY,
    LEVELS.EDIT,
  );

  const raw = await searchParams;
  const parsed = subscriptionsListSearchParamsSchema.parse({
    q: firstValue(raw.q),
    status: firstValue(raw.status) ?? null,
    sort: firstValue(raw.sort),
    page: firstValue(raw.page) ?? 1,
    subscription: firstValue(raw.subscription) ?? null,
  });

  const timezone = getAppTimezone(); // sync accessor — outside Promise.all
  const [subscriptionPage, locale, detail] = await Promise.all([
    listSubscriptions(parsed),
    getAppLocale(),
    parsed.subscription
      ? getSubscriptionDetail(parsed.subscription)
      : Promise.resolve(null),
  ]);

  return (
    <main className="space-y-5 p-5">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">Subscriptions</h1>
      </header>

      <Suspense>
        <SubscriptionsTable
          rows={subscriptionPage.rows}
          total={subscriptionPage.total}
          page={subscriptionPage.page}
          pageSize={subscriptionPage.pageSize}
          selectedInventoryId={parsed.subscription}
          detail={detail}
          canEdit={canEdit}
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
