import { beforeEach, describe, expect, it, vi } from "vitest";

// The wizard-reads action imports seven cross-module service functions; mock
// every one so importing the action never transitively loads `@/db/client`
// (which throws on the test env's missing DATABASE_URL). Only `listOfferings`
// and `getOfferingDetail` are exercised here — the rest are stubbed so the
// module resolves.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/customer/search-customers", () => ({
  searchCustomers: vi.fn(),
}));
vi.mock("@/services/accounts/search-accounts", () => ({
  searchAccounts: vi.fn(),
}));
vi.mock("@/services/accounts/get-financial-account-detail", () => ({
  getFinancialAccountDetail: vi.fn(),
}));
vi.mock("@/services/accounts/get-billing-account-detail", () => ({
  getBillingAccountDetail: vi.fn(),
}));
vi.mock("@/services/accounts/term-resolution", () => ({
  resolveTerm: vi.fn(),
}));
vi.mock("@/services/product/list-offerings", () => ({
  listOfferings: vi.fn(),
}));
vi.mock("@/services/product/get-offering-detail", () => ({
  getOfferingDetail: vi.fn(),
}));

import { requirePermission } from "@/auth/guard";
import { listOfferings } from "@/services/product/list-offerings";
import { getOfferingDetail } from "@/services/product/get-offering-detail";
import {
  wizardGetOfferingDetailAction,
  wizardSearchOfferingsAction,
} from "@/actions/accounts/new-order-wizard-reads";
import type { OfferingDetail, OfferingListRow } from "@/types/product";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListOfferings = vi.mocked(listOfferings);
const mockGetOfferingDetail = vi.mocked(getOfferingDetail);

function offeringRow(
  overrides: Partial<OfferingListRow> & { productOfferingId: string },
): OfferingListRow {
  return {
    name: "Offer",
    lifecycleStatus: "ACTIVE",
    version: 1,
    isSellable: true,
    billingOnly: true,
    lastModified: new Date("2026-01-01"),
    familyOfferingId: null,
    ...overrides,
  };
}

function offeringDetail(overrides: Partial<OfferingDetail>): OfferingDetail {
  return {
    productOfferingId: "PRDOFR00000001",
    name: "Fiber 100",
    isBundle: false,
    isSellable: true,
    billingOnly: true,
    lifecycleStatus: "ACTIVE",
    version: 1,
    lastModified: new Date("2026-01-01"),
    lastEditedByName: null,
    specifications: [],
    prices: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockListOfferings.mockReset();
  mockGetOfferingDetail.mockReset();
  // Default: caller is authorized. `canActOnOrders` only needs the call to
  // resolve, not any particular shape.
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
      product_orders: "EDIT",
    },
  });
});

describe("wizardSearchOfferingsAction", () => {
  it("collects eligible offerings across every page, dropping non-eligible rows", async () => {
    // Two pages (pageSize 2, total 3). Page 1 carries one eligible + one
    // non-sellable; page 2 carries a further eligible row — which page-1-only
    // filtering would have silently dropped.
    mockListOfferings.mockImplementation(async (params) => {
      if (params.page === 1) {
        return {
          rows: [
            offeringRow({ productOfferingId: "PRDOFR00000001", name: "A" }),
            offeringRow({
              productOfferingId: "PRDOFR00000002",
              name: "B",
              isSellable: false,
            }),
          ],
          total: 3,
          page: 1,
          pageSize: 2,
        };
      }
      return {
        rows: [
          offeringRow({
            productOfferingId: "PRDOFR00000003",
            name: "C",
            version: 2,
          }),
        ],
        total: 3,
        page: params.page,
        pageSize: 2,
      };
    });

    const result = await wizardSearchOfferingsAction("fiber");

    expect(result).toEqual([
      { productOfferingId: "PRDOFR00000001", name: "A", version: 1 },
      { productOfferingId: "PRDOFR00000003", name: "C", version: 2 },
    ]);
    // Page 1 + the one remaining page were both read.
    expect(mockListOfferings).toHaveBeenCalledTimes(2);
    expect(mockListOfferings).toHaveBeenCalledWith(
      expect.objectContaining({ q: "fiber", status: "ACTIVE", page: 1 }),
    );
    expect(mockListOfferings).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2 }),
    );
  });

  it("does not page-loop when the first page already covers the total", async () => {
    mockListOfferings.mockResolvedValue({
      rows: [offeringRow({ productOfferingId: "PRDOFR00000001", name: "A" })],
      total: 1,
      page: 1,
      pageSize: 5,
    });

    const result = await wizardSearchOfferingsAction("fiber");

    expect(result).toEqual([
      { productOfferingId: "PRDOFR00000001", name: "A", version: 1 },
    ]);
    expect(mockListOfferings).toHaveBeenCalledTimes(1);
  });

  it("throws (rather than silently truncating) when the match set exceeds the safety ceiling", async () => {
    mockListOfferings.mockResolvedValue({
      rows: [offeringRow({ productOfferingId: "PRDOFR00000001" })],
      total: 201, // > MAX_OFFERING_SEARCH_ROWS (200)
      page: 1,
      pageSize: 5,
    });

    await expect(wizardSearchOfferingsAction("fiber")).rejects.toThrow(
      /safety ceiling/,
    );
    // No further pages fetched once the ceiling is tripped.
    expect(mockListOfferings).toHaveBeenCalledTimes(1);
  });

  it("returns null and never queries when the caller lacks permission", async () => {
    mockRequirePermission.mockRejectedValue(new Error("forbidden"));

    const result = await wizardSearchOfferingsAction("fiber");

    expect(result).toBeNull();
    expect(mockListOfferings).not.toHaveBeenCalled();
  });
});

describe("wizardGetOfferingDetailAction", () => {
  const ineligibleCases: {
    label: string;
    overrides: Partial<OfferingDetail>;
  }[] = [
    { label: "non-ACTIVE", overrides: { lifecycleStatus: "RETIRED" } },
    { label: "non-sellable", overrides: { isSellable: false } },
    { label: "non-billing-only", overrides: { billingOnly: false } },
  ];

  it.each(ineligibleCases)(
    "returns null for a $label offering (mirrors pm28's OFFERING_NOT_ORDERABLE)",
    async ({ overrides }) => {
      mockGetOfferingDetail.mockResolvedValue(offeringDetail(overrides));

      const result = await wizardGetOfferingDetailAction("PRDOFR00000001");

      expect(result).toBeNull();
    },
  );

  it("returns the detail for an ACTIVE, sellable, billing-only offering", async () => {
    const detail = offeringDetail({});
    mockGetOfferingDetail.mockResolvedValue(detail);

    const result = await wizardGetOfferingDetailAction("PRDOFR00000001");

    expect(result).toBe(detail);
  });

  it("returns null when the offering is not found", async () => {
    mockGetOfferingDetail.mockResolvedValue(null);

    const result = await wizardGetOfferingDetailAction("PRDOFR99999999");

    expect(result).toBeNull();
  });

  it("returns null and never queries when the caller lacks permission", async () => {
    mockRequirePermission.mockRejectedValue(new Error("forbidden"));

    const result = await wizardGetOfferingDetailAction("PRDOFR00000001");

    expect(result).toBeNull();
    expect(mockGetOfferingDetail).not.toHaveBeenCalled();
  });
});
