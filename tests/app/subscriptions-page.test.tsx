import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test (orders-page.test.tsx precedent) — asserts
// requirePermission is invoked with the right permission/level, that its
// redirect propagates, and that the page threads props into its child, not
// that it renders pixels.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/inventory/list-subscriptions", () => ({
  listSubscriptions: vi.fn(),
}));
vi.mock("@/services/inventory/get-subscription-detail", () => ({
  getSubscriptionDetail: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
  getAppLocale: vi.fn().mockResolvedValue("en-US"),
}));
vi.mock("@/components/products/inventory/subscriptions-table", () => ({
  SubscriptionsTable: vi.fn(() => null),
}));

import SubscriptionsPage from "@/app/(app)/products/subscriptions/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { SubscriptionsTable } from "@/components/products/inventory/subscriptions-table";
import { getSubscriptionDetail } from "@/services/inventory/get-subscription-detail";
import { listSubscriptions } from "@/services/inventory/list-subscriptions";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListSubscriptions = vi.mocked(listSubscriptions);
const mockGetSubscriptionDetail = vi.mocked(getSubscriptionDetail);

// The page is a Server Component: calling it directly returns a React
// element tree without invoking child component functions, so we find
// elements by type and read their props directly (orders-page.test.tsx
// precedent).
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
  mockListSubscriptions.mockReset();
  mockGetSubscriptionDetail.mockReset();
  vi.mocked(SubscriptionsTable).mockClear();

  mockListSubscriptions.mockResolvedValue({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  mockGetSubscriptionDetail.mockResolvedValue(null);
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: null,
      customers: null,
      product_inventory: "READ",
    },
  });
});

describe("SubscriptionsPage", () => {
  it("calls requirePermission(PERMISSIONS.PRODUCT_INVENTORY, LEVELS.READ) as the first statement", async () => {
    await SubscriptionsPage({ searchParams: Promise.resolve({}) });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCT_INVENTORY,
      LEVELS.READ,
    );
    expect(mockListSubscriptions).toHaveBeenCalled();
  });

  it("propagates the /no-access redirect for a user without product_inventory:READ and never calls listSubscriptions", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(
      SubscriptionsPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow();
    expect(mockListSubscriptions).not.toHaveBeenCalled();
  });

  it("deep link reproduces the view: listSubscriptions receives the exact parsed searchParams", async () => {
    await SubscriptionsPage({
      searchParams: Promise.resolve({
        q: "Acme",
        status: "SUSPENDED",
        sort: "status",
        page: "2",
        subscription: "PRDINV00000002",
      }),
    });

    expect(mockListSubscriptions).toHaveBeenCalledWith({
      q: "Acme",
      status: "SUSPENDED",
      sort: "status",
      page: 2,
      subscription: "PRDINV00000002",
    });
  });

  it("tampered URL falls back to defaults", async () => {
    await SubscriptionsPage({
      searchParams: Promise.resolve({
        status: "BOGUS",
        sort: "drop table",
        page: "-3",
        subscription: "not-an-id",
      }),
    });

    expect(mockListSubscriptions).toHaveBeenCalledWith({
      q: "",
      status: null,
      sort: "-start_date",
      page: 1,
      subscription: null,
    });
  });

  it("fetches the subscription detail only for a well-formed ?subscription= id", async () => {
    await SubscriptionsPage({
      searchParams: Promise.resolve({ subscription: "PRDINV00000001" }),
    });

    expect(mockGetSubscriptionDetail).toHaveBeenCalledWith("PRDINV00000001");
  });

  it("an unknown but well-formed subscription id resolves to a null detail (empty state, not an error)", async () => {
    mockGetSubscriptionDetail.mockResolvedValue(null);

    const result = await SubscriptionsPage({
      searchParams: Promise.resolve({ subscription: "PRDINV00009999" }),
    });

    const table = findElementByType(result, SubscriptionsTable);
    expect(table?.props).toMatchObject({
      selectedInventoryId: "PRDINV00009999",
      detail: null,
    });
  });

  it("threads canEdit=true, locale, timezone, and the fetched page into SubscriptionsTable", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "user-1",
      userEmail: "user@example.com",
      permissionMap: {
        users: null,
        roles: null,
        system_config: null,
        audit_log: null,
        products: null,
        customers: null,
        product_inventory: "EDIT",
      },
    });
    const fixtureRow = {
      inventoryId: "PRDINV00000001",
      customerName: "Acme Corp",
      billingAccountId: "BAN00000001",
      offeringName: "5G Unlimited",
      offeringVersion: 2,
      hasOverride: false,
      quantity: 1,
      startDate: "2026-08-01",
      endDate: null,
      status: "ACTIVE" as const,
    };
    mockListSubscriptions.mockResolvedValue({
      rows: [fixtureRow],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const result = await SubscriptionsPage({
      searchParams: Promise.resolve({}),
    });

    const table = findElementByType(result, SubscriptionsTable);
    expect(table?.props).toMatchObject({
      rows: [fixtureRow],
      total: 1,
      page: 1,
      pageSize: 20,
      canEdit: true,
      locale: "en-US",
      timezone: "UTC",
    });
  });

  it("threads canEdit=false for a READ-only principal", async () => {
    const result = await SubscriptionsPage({
      searchParams: Promise.resolve({}),
    });

    const table = findElementByType(result, SubscriptionsTable);
    expect(table?.props).toMatchObject({ canEdit: false });
  });
});
