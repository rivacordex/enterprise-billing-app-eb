import type { Metadata } from "next";
import { Suspense } from "react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { actorHasRole } from "@/auth/roles";
import { OrderReviewPanel } from "@/components/products/ordering/order-review-panel";
import { OrdersTable } from "@/components/products/ordering/orders-table";
import { getBillingAccountDetail } from "@/services/accounts/get-billing-account-detail";
import { resolveTerm } from "@/services/accounts/term-resolution";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";
import { getOrderDetail } from "@/services/ordering/get-order-detail";
import { listOrders } from "@/services/ordering/list-orders";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { getUserById } from "@/services/users/users-read.service";
import { hasLevel } from "@/types/permissions";
import { ordersListSearchParamsSchema } from "@/validation/ordering/orders-list.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Orders — Enterprise Billing",
};

const MANAGER_ROLE = "MANAGER";

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { userId, permissionMap } = await requirePermission(
    PERMISSIONS.PRODUCT_ORDERS,
    LEVELS.READ,
  );

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

  // pm31 — compose the review panel for the `?order=`-selected order. Reuses
  // getOrderDetail (pm26) unchanged for the substantive review data and layers
  // resolved display fields (customer/BAN/cycle/terms/user names) from existing
  // read services on top. An unknown/ill-formed id yields null → no panel
  // (empty-selection, not an error — matches the table's own row-match rule).
  const reviewPanel = parsed.order
    ? await buildReviewPanel(
        parsed.order,
        userId,
        permissionMap,
        locale,
        timezone,
      )
    : null;

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

      {reviewPanel}
    </main>
  );
}

async function buildReviewPanel(
  orderId: string,
  userId: string,
  permissionMap: Parameters<typeof hasLevel>[0],
  locale: string,
  timezone: string,
): Promise<React.JSX.Element | null> {
  const order = await getOrderDetail(orderId);
  if (!order) return null;

  const [customer, banDetail, submitter, reviewer] = await Promise.all([
    getCustomerDetail(order.customerPartyRoleId),
    getBillingAccountDetail(order.billingAccountId),
    getUserById(order.submittedBy),
    order.reviewedBy ? getUserById(order.reviewedBy) : Promise.resolve(null),
  ]);

  // Eligibility resolved server-side (architecture §4): MANAGER role ∧
  // product_orders:EDIT ∧ reviewer ≠ submitter. pm30 enforces the same,
  // independent of this — the flag only disables the buttons + shows why.
  const isManager = await actorHasRole(userId, MANAGER_ROLE);
  const hasEdit = hasLevel(
    permissionMap,
    PERMISSIONS.PRODUCT_ORDERS,
    LEVELS.EDIT,
  );
  const isSubmitter = userId === order.submittedBy;
  const canReview = isManager && hasEdit && !isSubmitter;

  const reviewDisabledReason = isSubmitter
    ? "You submitted this order"
    : !isManager
      ? "Requires MANAGER role"
      : !hasEdit
        ? "Requires edit permission on orders"
        : null;

  const banDetailCurrency = banDetail?.ban.currency ?? "";
  const banName = banDetail?.ban.name ?? order.billingAccountId;
  const billCycleName = banDetail?.billCycle.name ?? "—";
  const paymentTermsDays = banDetail
    ? resolveTerm(
        banDetail.ban.paymentDueDaysOverride,
        banDetail.billCycle.paymentDueDays,
      )
    : 0;

  return (
    <OrderReviewPanel
      order={order}
      customerName={customer?.organization.name ?? order.customerPartyRoleId}
      banName={banName}
      banCurrency={banDetailCurrency}
      billCycleName={billCycleName}
      paymentTermsDays={paymentTermsDays}
      submittedByName={submitter?.userName ?? order.submittedBy}
      reviewedByName={reviewer?.userName ?? null}
      canReview={canReview}
      reviewDisabledReason={reviewDisabledReason}
      locale={locale}
      timezone={timezone}
    />
  );
}
