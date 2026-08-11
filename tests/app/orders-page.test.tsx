import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test only (product-offering-page.test.tsx precedent) — asserts
// requirePermission is invoked with the right permission/level and that its
// redirect propagates, not that the page renders pixels.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/ordering/list-orders", () => ({ listOrders: vi.fn() }));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
  getAppLocale: vi.fn().mockResolvedValue("en-US"),
}));
vi.mock("@/components/products/ordering/orders-table", () => ({
  OrdersTable: vi.fn(() => null),
}));

import OrdersPage from "@/app/(app)/products/orders/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { OrdersTable } from "@/components/products/ordering/orders-table";
import { listOrders } from "@/services/ordering/list-orders";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListOrders = vi.mocked(listOrders);

// The page is a Server Component: calling it directly returns a React
// element tree without ever invoking child component functions, so we find
// the `OrdersTable` element by type and read its props directly rather than
// relying on a mock capturing an invocation.
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

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockListOrders.mockReset();
  vi.mocked(OrdersTable).mockClear();
  mockListOrders.mockResolvedValue({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
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

  it("an unknown but well-formed order ID still threads through as the selected id (empty-selection, not an error)", async () => {
    mockListOrders.mockResolvedValue({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });

    const result = await OrdersPage({
      searchParams: Promise.resolve({ order: "PRDORD00009999" }),
    });

    const table = findElementByType(result, OrdersTable);
    expect(table?.props).toMatchObject({
      selectedOrderId: "PRDORD00009999",
      rows: [],
    });
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
});
