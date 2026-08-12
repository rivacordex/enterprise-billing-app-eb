import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test (product-offering-page.test.tsx precedent) — asserts
// requirePermission is invoked with the right permission/level, that its
// redirect propagates, and that the page threads props into its children,
// not that it renders pixels.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/auth/roles", () => ({ actorHasRole: vi.fn() }));
vi.mock("@/services/ordering/list-orders", () => ({ listOrders: vi.fn() }));
vi.mock("@/services/ordering/get-order-detail", () => ({
  getOrderDetail: vi.fn(),
}));
vi.mock("@/services/accounts/get-billing-account-detail", () => ({
  getBillingAccountDetail: vi.fn(),
}));
vi.mock("@/services/accounts/term-resolution", () => ({
  resolveTerm: vi.fn(),
}));
vi.mock("@/services/customer/get-customer-detail", () => ({
  getCustomerDetail: vi.fn(),
}));
vi.mock("@/services/users/users-read.service", () => ({
  getUserById: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
  getAppLocale: vi.fn().mockResolvedValue("en-US"),
}));
vi.mock("@/components/products/ordering/orders-table", () => ({
  OrdersTable: vi.fn(() => null),
}));
vi.mock("@/components/products/ordering/order-review-panel", () => ({
  OrderReviewPanel: vi.fn(() => null),
}));

import OrdersPage from "@/app/(app)/products/orders/page";
import { requirePermission } from "@/auth/guard";
import { actorHasRole } from "@/auth/roles";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { OrderReviewPanel } from "@/components/products/ordering/order-review-panel";
import { OrdersTable } from "@/components/products/ordering/orders-table";
import { getBillingAccountDetail } from "@/services/accounts/get-billing-account-detail";
import { resolveTerm } from "@/services/accounts/term-resolution";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";
import { getOrderDetail } from "@/services/ordering/get-order-detail";
import { listOrders } from "@/services/ordering/list-orders";
import { getUserById } from "@/services/users/users-read.service";
import type { OrderDetail } from "@/types/ordering";

const mockRequirePermission = vi.mocked(requirePermission);
const mockActorHasRole = vi.mocked(actorHasRole);
const mockListOrders = vi.mocked(listOrders);
const mockGetOrderDetail = vi.mocked(getOrderDetail);
const mockGetBillingAccountDetail = vi.mocked(getBillingAccountDetail);
const mockResolveTerm = vi.mocked(resolveTerm);
const mockGetCustomerDetail = vi.mocked(getCustomerDetail);
const mockGetUserById = vi.mocked(getUserById);

// The page is a Server Component: calling it directly returns a React element
// tree without invoking child component functions, so we find elements by type
// and read their props directly.
interface ReactElementLike {
  type: unknown;
  props: { children?: unknown };
}

function isReactElementLike(node: unknown): node is ReactElementLike {
  return (
    node !== null &&
    typeof node === "object" &&
    "type" in node &&
    "props" in node
  );
}

function findElementByType(
  node: unknown,
  type: unknown,
): ReactElementLike | undefined {
  if (!isReactElementLike(node)) return undefined;
  if (node.type === type) return node;

  const children = node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElementByType(child, type);
    if (found) return found;
  }
  return undefined;
}

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

function makeOrderDetail(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    productOrderId: "PRDORD00000002",
    customerPartyRoleId: "PTRL00000001",
    billingAccountId: "BAN00000001",
    status: "PENDING",
    failureReason: null,
    submittedBy: "someone-else",
    submittedAt: new Date("2026-08-01T10:00:00.000Z"),
    reviewedBy: null,
    reviewedAt: null,
    completedAt: null,
    item: {
      productOrderItemId: "PRDORI00000001",
      productOfferingId: "PRDOFR00000001",
      offeringName: "5G Unlimited",
      offeringVersion: 2,
      quantity: 1,
      startDate: "2026-08-15",
      orderedCharacteristics: null,
    },
    prices: [],
    ...overrides,
  };
}

function stubReviewReads(): void {
  mockGetCustomerDetail.mockResolvedValue({
    organization: { name: "Acme Corp" },
  } as unknown as Awaited<ReturnType<typeof getCustomerDetail>>);
  mockGetBillingAccountDetail.mockResolvedValue({
    ban: { name: "BAN Main", currency: "USD", paymentDueDaysOverride: null },
    billCycle: { name: "Monthly", paymentDueDays: 30 },
  } as unknown as Awaited<ReturnType<typeof getBillingAccountDetail>>);
  mockResolveTerm.mockReturnValue(30);
  mockGetUserById.mockResolvedValue({
    userName: "Jordan Rivera",
  } as unknown as Awaited<ReturnType<typeof getUserById>>);
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockActorHasRole.mockReset();
  mockListOrders.mockReset();
  mockGetOrderDetail.mockReset();
  mockGetBillingAccountDetail.mockReset();
  mockResolveTerm.mockReset();
  mockGetCustomerDetail.mockReset();
  mockGetUserById.mockReset();
  vi.mocked(OrdersTable).mockClear();
  vi.mocked(OrderReviewPanel).mockClear();

  mockListOrders.mockResolvedValue({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  mockGetOrderDetail.mockResolvedValue(null);
  mockActorHasRole.mockResolvedValue(false);
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: null,
      customers: null,
      product_orders: "READ",
    },
  });
});

describe("OrdersPage", () => {
  it("calls requirePermission(PERMISSIONS.PRODUCT_ORDERS, LEVELS.READ) as the first statement", async () => {
    await OrdersPage({ searchParams: Promise.resolve({}) });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCT_ORDERS,
      LEVELS.READ,
    );
    expect(mockListOrders).toHaveBeenCalled();
  });

  it("propagates the /no-access redirect for a user without product_orders:READ and never calls listOrders", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(
      OrdersPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow();
    expect(mockListOrders).not.toHaveBeenCalled();
  });

  it("deep link reproduces the view: listOrders receives the exact parsed searchParams", async () => {
    await OrdersPage({
      searchParams: Promise.resolve({
        q: "Acme",
        status: "PENDING",
        sort: "status",
        page: "2",
        order: "PRDORD00000002",
      }),
    });

    expect(mockListOrders).toHaveBeenCalledWith({
      q: "Acme",
      status: "PENDING",
      sort: "status",
      page: 2,
      order: "PRDORD00000002",
    });
  });

  it("tampered URL falls back to defaults", async () => {
    await OrdersPage({
      searchParams: Promise.resolve({
        status: "BOGUS",
        sort: "drop table",
        page: "-3",
        order: "not-an-order-id",
      }),
    });

    expect(mockListOrders).toHaveBeenCalledWith({
      q: "",
      status: null,
      sort: "-submitted_at",
      page: 1,
      order: null,
    });
  });

  it("an unknown but well-formed order ID renders no panel (empty-selection, not an error)", async () => {
    const result = await OrdersPage({
      searchParams: Promise.resolve({ order: "PRDORD00009999" }),
    });

    expect(mockGetOrderDetail).toHaveBeenCalledWith("PRDORD00009999");
    const table = findElementByType(result, OrdersTable);
    expect(table?.props).toMatchObject({ selectedOrderId: "PRDORD00009999" });
    expect(findElementByType(result, OrderReviewPanel)).toBeUndefined();
  });

  it("threads locale, timezone, and the fetched page into OrdersTable", async () => {
    const fixtureRow = {
      orderId: "PRDORD00000001",
      customerName: "Acme Corp",
      customerPartyRoleId: "PTRL00000001",
      billingAccountId: "BAN00000001",
      offeringName: "5G Unlimited",
      offeringVersion: 2,
      quantity: 1,
      startDate: "2026-08-01",
      hasOverride: false,
      status: "COMPLETED" as const,
      submittedByName: "Jordan Rivera",
      submittedAt: new Date("2026-07-30T10:00:00.000Z"),
      reviewedByName: null,
      reviewedAt: null,
    };
    mockListOrders.mockResolvedValue({
      rows: [fixtureRow],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const result = await OrdersPage({ searchParams: Promise.resolve({}) });

    const table = findElementByType(result, OrdersTable);
    expect(table?.props).toMatchObject({
      rows: [fixtureRow],
      total: 1,
      page: 1,
      pageSize: 20,
      locale: "en-US",
      timezone: "UTC",
    });
  });

  it("renders the review panel with canReview=true for a MANAGER (≠ submitter) holding EDIT", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "manager-1",
      userEmail: "m@example.com",
      permissionMap: {
        users: null,
        roles: null,
        system_config: null,
        audit_log: null,
        products: null,
        customers: null,
        product_orders: "EDIT",
      },
    });
    mockActorHasRole.mockResolvedValue(true);
    mockGetOrderDetail.mockResolvedValue(makeOrderDetail());
    stubReviewReads();

    const result = await OrdersPage({
      searchParams: Promise.resolve({ order: "PRDORD00000002" }),
    });

    expect(mockActorHasRole).toHaveBeenCalledWith("manager-1", "MANAGER");
    const panel = findElementByType(result, OrderReviewPanel);
    expect(panel?.props).toMatchObject({
      canReview: true,
      reviewDisabledReason: null,
      customerName: "Acme Corp",
      banName: "BAN Main",
      banCurrency: "USD",
      billCycleName: "Monthly",
      paymentTermsDays: 30,
      submittedByName: "Jordan Rivera",
    });
  });

  it("marks canReview=false with the submitter reason when the viewer submitted the order", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "manager-1",
      userEmail: "m@example.com",
      permissionMap: {
        users: null,
        roles: null,
        system_config: null,
        audit_log: null,
        products: null,
        customers: null,
        product_orders: "EDIT",
      },
    });
    mockActorHasRole.mockResolvedValue(true);
    mockGetOrderDetail.mockResolvedValue(
      makeOrderDetail({ submittedBy: "manager-1" }),
    );
    stubReviewReads();

    const result = await OrdersPage({
      searchParams: Promise.resolve({ order: "PRDORD00000002" }),
    });

    const panel = findElementByType(result, OrderReviewPanel);
    expect(panel?.props).toMatchObject({
      canReview: false,
      reviewDisabledReason: "You submitted this order",
    });
  });

  it("marks canReview=false with the manager reason for a non-manager EDIT holder", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "editor-1",
      userEmail: "e@example.com",
      permissionMap: {
        users: null,
        roles: null,
        system_config: null,
        audit_log: null,
        products: null,
        customers: null,
        product_orders: "EDIT",
      },
    });
    mockActorHasRole.mockResolvedValue(false);
    mockGetOrderDetail.mockResolvedValue(makeOrderDetail());
    stubReviewReads();

    const result = await OrdersPage({
      searchParams: Promise.resolve({ order: "PRDORD00000002" }),
    });

    const panel = findElementByType(result, OrderReviewPanel);
    expect(panel?.props).toMatchObject({
      canReview: false,
      reviewDisabledReason: "Requires MANAGER role",
    });
  });
});
