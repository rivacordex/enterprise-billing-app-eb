import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test only (audit-log-page.test.tsx precedent) — asserts
// requirePermission is invoked with the right permission/level and that its
// redirect propagates, not that the page renders pixels.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/list-offerings", () => ({
  listOfferings: vi.fn(),
}));
vi.mock("@/services/product/get-offering-detail", () => ({
  getOfferingDetail: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
  getAppLocale: vi.fn().mockResolvedValue("en-US"),
}));
vi.mock("@/components/products/offering-table", () => ({
  OfferingTable: vi.fn(() => null),
}));
vi.mock("@/components/products/offering-detail-region", () => ({
  OfferingDetailRegion: vi.fn(() => null),
}));

import ProductOfferingPage from "@/app/(app)/products/product-offering/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { OfferingDetailRegion } from "@/components/products/offering-detail-region";
import { getOfferingDetail } from "@/services/product/get-offering-detail";
import { listOfferings } from "@/services/product/list-offerings";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListOfferings = vi.mocked(listOfferings);
const mockGetOfferingDetail = vi.mocked(getOfferingDetail);

// The page is a Server Component: calling it directly returns a React
// element tree without ever invoking child component functions, so we find
// the `OfferingDetailRegion` element by type and read its props directly
// rather than relying on a mock capturing an invocation.
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
  mockListOfferings.mockReset();
  mockGetOfferingDetail.mockReset();
  mockListOfferings.mockResolvedValue({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 5,
  });
  mockGetOfferingDetail.mockResolvedValue(null);
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: "READ",
    },
  });
});

describe("ProductOfferingPage", () => {
  it("calls requirePermission(PERMISSIONS.PRODUCTS, LEVELS.READ) as the first statement", async () => {
    await ProductOfferingPage({ searchParams: Promise.resolve({}) });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.READ,
    );
    expect(mockListOfferings).toHaveBeenCalled();
  });

  it("propagates the /no-access redirect for a user without products:READ and never calls listOfferings", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(
      ProductOfferingPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow();
    expect(mockListOfferings).not.toHaveBeenCalled();
    expect(mockGetOfferingDetail).not.toHaveBeenCalled();
  });

  it("deep link reproduces the view: listOfferings and getOfferingDetail receive the exact parsed searchParams", async () => {
    await ProductOfferingPage({
      searchParams: Promise.resolve({
        q: "5G",
        status: "ACTIVE",
        sort: "-last_modified",
        page: "2",
        offering: "PRDOFR000001",
      }),
    });

    expect(mockListOfferings).toHaveBeenCalledWith({
      q: "5G",
      status: "ACTIVE",
      sort: "-last_modified",
      page: 2,
      offering: "PRDOFR000001",
    });
    expect(mockGetOfferingDetail).toHaveBeenCalledWith("PRDOFR000001");
  });

  it("tampered URL falls back to defaults and does not call getOfferingDetail", async () => {
    await ProductOfferingPage({
      searchParams: Promise.resolve({
        status: "BOGUS",
        sort: "drop table",
        page: "-3",
        offering: "PRDSMD000001",
      }),
    });

    expect(mockListOfferings).toHaveBeenCalledWith({
      q: "",
      status: null,
      sort: "name",
      page: 1,
      offering: null,
    });
    expect(mockGetOfferingDetail).not.toHaveBeenCalled();
  });

  it("an unknown but well-formed offering ID resolves to notFound:true, hasSelection:true", async () => {
    mockGetOfferingDetail.mockResolvedValue(null);

    const result = await ProductOfferingPage({
      searchParams: Promise.resolve({ offering: "PRDOFR999999" }),
    });

    const detailRegion = findElementByType(result, OfferingDetailRegion);
    expect(detailRegion?.props).toMatchObject({
      hasSelection: true,
      notFound: true,
    });
  });

  it("threads the resolved offering, locale, and timezone into OfferingDetailRegion on a resolved deep link", async () => {
    const fixtureOffering = {
      productOfferingId: "PRDOFR000001",
      name: "5G Nationwide Service Plan",
      isBundle: false,
      isSellable: true,
      billingOnly: false,
      lifecycleStatus: "ACTIVE" as const,
      version: 3,
      lastModified: new Date("2026-07-03T14:22:00.000Z"),
      lastEditedByName: "Jordan Rivera",
      specifications: [],
      prices: [],
    };
    mockGetOfferingDetail.mockResolvedValue(fixtureOffering);

    const result = await ProductOfferingPage({
      searchParams: Promise.resolve({ offering: "PRDOFR000001" }),
    });

    const detailRegion = findElementByType(result, OfferingDetailRegion);
    expect(detailRegion?.props).toMatchObject({
      offering: fixtureOffering,
      locale: "en-US",
      timezone: "UTC",
    });
  });
});
