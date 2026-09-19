import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FamilyPage } from "@/types/product";

// Guard-level + orchestration test (product-offering-page.test.tsx precedent):
// asserts requirePermission gates the page and that the parsed searchParams flow
// into listFamilies and the resulting page into FamilyTable — not that
// FamilyTable renders pixels (pm39 replaced the fetch-everything page).
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/list-families", () => ({
  listFamilies: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppName: vi.fn().mockResolvedValue("Acme Telco"),
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
  getAppLocale: vi.fn().mockResolvedValue("en-US"),
}));
vi.mock("@/components/products/manage/family-table", () => ({
  FamilyTable: vi.fn(() => null),
}));
vi.mock("@/components/products/manage/create-offering-dialog", () => ({
  CreateOfferingDialog: vi.fn(() => null),
}));

import ManageProductsPage from "@/app/(app)/products/manage-products/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { FamilyTable } from "@/components/products/manage/family-table";
import { listFamilies } from "@/services/product/list-families";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListFamilies = vi.mocked(listFamilies);

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
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

function emptyPage(): FamilyPage {
  return { rows: [], total: 0, page: 1, pageSize: 5 };
}

async function renderPage(
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<React.JSX.Element> {
  return ManageProductsPage({ searchParams: Promise.resolve(searchParams) });
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockListFamilies.mockReset();
  vi.mocked(FamilyTable).mockClear();
  mockListFamilies.mockResolvedValue(emptyPage());
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
  it("calls requirePermission(PERMISSIONS.PRODUCTS, LEVELS.EDIT) and then lists families", async () => {
    await renderPage();

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.PRODUCTS,
      LEVELS.EDIT,
    );
    expect(mockListFamilies).toHaveBeenCalled();
  });

  it("propagates the /no-access redirect and never lists families", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(renderPage()).rejects.toThrow();
    expect(mockListFamilies).not.toHaveBeenCalled();
  });

  it("parses searchParams and passes them to listFamilies", async () => {
    await renderPage({ q: "fibre", status: "ACTIVE", page: "2" });

    expect(mockListFamilies).toHaveBeenCalledWith(
      expect.objectContaining({ q: "fibre", status: "ACTIVE", page: 2 }),
    );
  });

  it("falls back to defaults for a tampered ?page=abc&status=NOPE", async () => {
    await renderPage({ page: "abc", status: "NOPE" });

    expect(mockListFamilies).toHaveBeenCalledWith(
      expect.objectContaining({ q: "", status: null, page: 1 }),
    );
  });

  it("passes the family page and parsed query/status to FamilyTable", async () => {
    const familyPage: FamilyPage = {
      rows: [
        {
          familyId: "PRDOFR000001",
          primaryVersionId: "PRDOFR000002",
          name: "Fibre 100",
          lifecycleStatus: "ACTIVE",
          version: 2,
          versionCount: 2,
          openVersionId: null,
          isSellable: true,
          billingOnly: false,
          lastModified: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 5,
    };
    mockListFamilies.mockResolvedValue(familyPage);

    const result = await renderPage({ q: "fibre" });
    const table = findElementByType(result, FamilyTable);

    expect(table?.props).toMatchObject({
      page: familyPage,
      query: "fibre",
      status: null,
      locale: "en-US",
      timezone: "UTC",
    });
  });
});
