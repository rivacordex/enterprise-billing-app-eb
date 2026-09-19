import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OfferingDetail, VersionSummary } from "@/types/product";

// pm40 I7. Orchestration test (manage-products-page.test.tsx precedent): asserts
// the page resolves the selected version (D1) and threads the versions + resolved
// offering into VersionBar and SelectionRegion — not that those leaves render
// pixels. `resolveSelectedVersion` is the real pure helper (its own five-case
// test covers the branches); services and leaf components are mocked so the
// assertions are about the data flow the page owns.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/list-families", () => ({ listFamilies: vi.fn() }));
vi.mock("@/services/product/list-family-versions", () => ({
  listFamilyVersions: vi.fn(),
}));
vi.mock("@/services/product/get-offering-detail", () => ({
  getOfferingDetail: vi.fn(),
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
vi.mock("@/components/products/manage/version-bar", () => ({
  VersionBar: vi.fn(() => null),
}));
vi.mock("@/components/products/manage/selection-region", () => ({
  SelectionRegion: vi.fn(() => null),
}));

import ManageProductsPage from "@/app/(app)/products/manage-products/page";
import { requirePermission } from "@/auth/guard";
import { SelectionRegion } from "@/components/products/manage/selection-region";
import { VersionBar } from "@/components/products/manage/version-bar";
import { getOfferingDetail } from "@/services/product/get-offering-detail";
import { listFamilies } from "@/services/product/list-families";
import { listFamilyVersions } from "@/services/product/list-family-versions";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListFamilies = vi.mocked(listFamilies);
const mockListFamilyVersions = vi.mocked(listFamilyVersions);
const mockGetOfferingDetail = vi.mocked(getOfferingDetail);

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

const FAMILY_ID = "PRDOFR000001";
const ACTIVE_ID = "PRDOFR000002";
const DRAFT_ID = "PRDOFR000003";

function versions(): VersionSummary[] {
  const lastModified = new Date("2026-01-01T00:00:00.000Z");
  return [
    {
      productOfferingId: DRAFT_ID,
      version: 3,
      lifecycleStatus: "DRAFT",
      lastModified,
    },
    {
      productOfferingId: ACTIVE_ID,
      version: 2,
      lifecycleStatus: "ACTIVE",
      lastModified,
    },
  ];
}

function offeringDetail(id: string): OfferingDetail {
  return {
    productOfferingId: id,
    name: "Fibre 100",
    isBundle: false,
    isSellable: true,
    billingOnly: false,
    lifecycleStatus: id === DRAFT_ID ? "DRAFT" : "ACTIVE",
    version: id === DRAFT_ID ? 3 : 2,
    lastModified: new Date("2026-01-01T00:00:00.000Z"),
    lastEditedByName: "Admin",
    specifications: [
      {
        productSpecId: "PRDSMD00000001",
        name: "Bandwidth",
        isMandatory: true,
        isDefault: false,
        defaultValue: null,
        characteristics: { SST_ID: "01" },
      },
    ],
    prices: [
      {
        productOfferingPriceId: "PRDOFP00000001",
        name: "Monthly",
        priceType: "recurring",
        pricingModel: "flat",
        amount: "100.00",
        currency: "RM",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        unitOfMeasure: null,
        glCode: "4000",
        policy: null,
        pricingCharacteristics: null,
        startDateTime: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        endDateTime: null,
        effectivityStatus: "current",
      },
    ],
  };
}

async function renderPage(
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<React.JSX.Element> {
  return ManageProductsPage({ searchParams: Promise.resolve(searchParams) });
}

beforeEach(() => {
  vi.clearAllMocks();
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
  mockListFamilies.mockResolvedValue({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 5,
  });
  mockListFamilyVersions.mockResolvedValue(versions());
});

describe("ManageProductsPage — version selection (pm40)", () => {
  it("selecting a family shows the primary version's detail, specifications and prices", async () => {
    mockGetOfferingDetail.mockResolvedValue(offeringDetail(ACTIVE_ID));

    const result = await renderPage({ family: FAMILY_ID });

    // family versions fetched for the bar; detail fetched for the primary
    // (ACTIVE) version since no ?version= was given (D1 case 2).
    expect(mockListFamilyVersions).toHaveBeenCalledWith(FAMILY_ID);
    expect(mockGetOfferingDetail).toHaveBeenCalledWith(ACTIVE_ID);

    const region = findElementByType(result, SelectionRegion);
    expect(region?.props).toMatchObject({ hasFamily: true });
    const offering = region?.props.offering as OfferingDetail;
    expect(offering.specifications).toHaveLength(1);
    expect(offering.prices).toHaveLength(1);

    const bar = findElementByType(result, VersionBar);
    expect(bar?.props).toMatchObject({
      selectedVersionId: ACTIVE_ID,
      family: FAMILY_ID,
    });
    expect(bar?.props.versions).toHaveLength(2);
  });

  it("switching version re-renders the panels for the requested version", async () => {
    mockGetOfferingDetail.mockResolvedValue(offeringDetail(DRAFT_ID));

    const result = await renderPage({ family: FAMILY_ID, version: DRAFT_ID });

    // The requested version belongs to the family (D1 case 3), so it wins.
    expect(mockGetOfferingDetail).toHaveBeenCalledWith(DRAFT_ID);
    const bar = findElementByType(result, VersionBar);
    expect(bar?.props.selectedVersionId).toBe(DRAFT_ID);
  });

  it("a ?version= from another family falls back to the primary version", async () => {
    mockGetOfferingDetail.mockResolvedValue(offeringDetail(ACTIVE_ID));

    await renderPage({ family: FAMILY_ID, version: "PRDOFR000099" });

    // Not a member of the family (D1 case 4) → the primary (ACTIVE) version.
    expect(mockGetOfferingDetail).toHaveBeenCalledWith(ACTIVE_ID);
  });

  it("an unknown ?family= renders the empty-selection state with no version bar", async () => {
    mockListFamilyVersions.mockResolvedValue([]);

    const result = await renderPage({ family: "PRDOFR000404" });

    // No versions ⇒ no detail read, no bar; the region shows the empty state
    // for a selected-but-missing family (D1 case 5).
    expect(mockGetOfferingDetail).not.toHaveBeenCalled();
    expect(findElementByType(result, VersionBar)).toBeUndefined();
    const region = findElementByType(result, SelectionRegion);
    expect(region?.props).toMatchObject({ hasFamily: true, offering: null });
  });

  it("no family selected fetches no versions and no detail", async () => {
    const result = await renderPage();

    expect(mockListFamilyVersions).not.toHaveBeenCalled();
    expect(mockGetOfferingDetail).not.toHaveBeenCalled();
    const region = findElementByType(result, SelectionRegion);
    expect(region?.props).toMatchObject({ hasFamily: false, offering: null });
  });
});
