import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OfferingListPage, OfferingListRow } from "@/types/product";

// Guard-level + orchestration test only (product-offering-page.test.tsx
// precedent) — asserts requirePermission gates the page and that
// fetchAllOfferingRows/groupIntoFamilies (private to page.tsx) produce the
// right shape, not that ManageOfferingTable renders pixels.
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
vi.mock("@/components/products/manage/manage-offering-table", () => ({
  ManageOfferingTable: vi.fn(() => null),
}));

import ManageProductsPage from "@/app/(app)/products/manage-products/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { ManageOfferingTable } from "@/components/products/manage/manage-offering-table";
import { getOfferingDetail } from "@/services/product/get-offering-detail";
import { listOfferings } from "@/services/product/list-offerings";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListOfferings = vi.mocked(listOfferings);
const mockGetOfferingDetail = vi.mocked(getOfferingDetail);

// The page is a Server Component: calling it directly returns a React
// element tree without ever invoking child component functions, so we find
// the `ManageOfferingTable` element by type and read its props directly.
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

function makeRow(overrides: Partial<OfferingListRow>): OfferingListRow {
  return {
    productOfferingId: "PRDOFR000001",
    name: "Offering",
    lifecycleStatus: "ACTIVE",
    version: 1,
    isSellable: true,
    billingOnly: false,
    lastModified: new Date("2026-01-01T00:00:00.000Z"),
    familyOfferingId: null,
    ...overrides,
  };
}

function emptyPage(): OfferingListPage {
  return { rows: [], total: 0, page: 1, pageSize: 5 };
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockListOfferings.mockReset();
  mockGetOfferingDetail.mockReset();
  vi.mocked(ManageOfferingTable).mockClear();
  mockListOfferings.mockResolvedValue(emptyPage());
  mockGetOfferingDetail.mockResolvedValue(null);
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: "EDIT",
      customers: null,
    },
  });
});

describe("ManageProductsPage", () => {
  it("calls requirePermission(PERMISSIONS.PRODUCTS, LEVELS.EDIT) as the first statement", async () => {
    await ManageProductsPage();

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    );
    expect(mockListOfferings).toHaveBeenCalled();
  });

  it("propagates the /no-access redirect for a user without products:EDIT and never calls listOfferings", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(ManageProductsPage()).rejects.toThrow();
    expect(mockListOfferings).not.toHaveBeenCalled();
  });

  it("fetches both status:null and status:RETIRED buckets", async () => {
    await ManageProductsPage();

    expect(mockListOfferings).toHaveBeenCalledWith(
      expect.objectContaining({ status: null }),
    );
    expect(mockListOfferings).toHaveBeenCalledWith(
      expect.objectContaining({ status: "RETIRED" }),
    );
  });

  it("loops across pages until every row in a status bucket is collected", async () => {
    const page1Rows = Array.from({ length: 5 }, (_, i) =>
      makeRow({
        productOfferingId: `PRDOFR00000${i + 1}`,
        name: `Offering ${i + 1}`,
      }),
    );
    const page2Rows = [
      makeRow({ productOfferingId: "PRDOFR000006", name: "Offering 6" }),
      makeRow({ productOfferingId: "PRDOFR000007", name: "Offering 7" }),
    ];

    mockListOfferings.mockImplementation(async (params) => {
      if (params.status === null) {
        if (params.page === 1) {
          return { rows: page1Rows, total: 7, page: 1, pageSize: 5 };
        }
        return { rows: page2Rows, total: 7, page: 2, pageSize: 5 };
      }
      return emptyPage();
    });

    const result = await ManageProductsPage();

    expect(mockListOfferings).toHaveBeenCalledWith(
      expect.objectContaining({ status: null, page: 1 }),
    );
    expect(mockListOfferings).toHaveBeenCalledWith(
      expect.objectContaining({ status: null, page: 2 }),
    );

    const table = findElementByType(result, ManageOfferingTable);
    expect(table?.props).toMatchObject({
      families: expect.arrayContaining([
        expect.objectContaining({
          primary: expect.objectContaining({
            productOfferingId: "PRDOFR000007",
          }),
        }),
      ]),
    });
    const tableProps = table?.props as { families: unknown[] };
    expect(tableProps.families).toHaveLength(7);
  });

  it("collapses same-family rows into one family row with the ACTIVE version as primary", async () => {
    const draftRoot = makeRow({
      productOfferingId: "PRDOFR000010",
      name: "Family Alpha",
      familyOfferingId: null,
      version: 1,
      lifecycleStatus: "DRAFT",
    });
    const activeBranch = makeRow({
      productOfferingId: "PRDOFR000011",
      name: "Family Alpha",
      familyOfferingId: "PRDOFR000010",
      version: 2,
      lifecycleStatus: "ACTIVE",
    });

    mockListOfferings.mockImplementation(async (params) => {
      if (params.status === null) {
        return {
          rows: [draftRoot, activeBranch],
          total: 2,
          page: 1,
          pageSize: 5,
        };
      }
      return emptyPage();
    });

    const result = await ManageProductsPage();
    const table = findElementByType(result, ManageOfferingTable);
    const tableProps = table?.props as {
      families: Array<{
        primary: OfferingListRow;
        versions: OfferingListRow[];
      }>;
    };

    expect(tableProps.families).toHaveLength(1);
    expect(tableProps.families[0]?.primary.productOfferingId).toBe(
      "PRDOFR000011",
    );
    expect(tableProps.families[0]?.versions).toHaveLength(2);
  });

  it("resolves the highest-version row as primary when no ACTIVE row exists in the family (RETIRED-primary case)", async () => {
    const retiredRow = makeRow({
      productOfferingId: "PRDOFR000004",
      name: "Legacy 4G Add-On",
      familyOfferingId: null,
      version: 3,
      lifecycleStatus: "RETIRED",
    });

    mockListOfferings.mockImplementation(async (params) => {
      if (params.status === "RETIRED") {
        return { rows: [retiredRow], total: 1, page: 1, pageSize: 5 };
      }
      return emptyPage();
    });

    const result = await ManageProductsPage();
    const table = findElementByType(result, ManageOfferingTable);
    const tableProps = table?.props as {
      families: Array<{ primary: OfferingListRow }>;
    };

    expect(tableProps.families).toHaveLength(1);
    expect(tableProps.families[0]?.primary.lifecycleStatus).toBe("RETIRED");
    expect(tableProps.families[0]?.primary.productOfferingId).toBe(
      "PRDOFR000004",
    );
  });
});
