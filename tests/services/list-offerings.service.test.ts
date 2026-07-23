import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/services/roles-read.service.test.ts: mock `@/db/client` so
// importing the service never triggers `lib/config`'s eager env validation.
vi.mock("@/db/client", () => ({ db: {} }));

vi.mock("@/db/repositories/product-offering", () => ({
  productOfferingRepository: { findList: vi.fn() },
}));
vi.mock("@/db/repositories/system-config.repository", () => ({
  systemConfigRepository: { findActiveValue: vi.fn() },
}));

import { productOfferingRepository } from "@/db/repositories/product-offering";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import {
  DEFAULT_OFFERING_LIST_PAGE_SIZE,
  listOfferings,
} from "@/services/product/list-offerings";
import type { OfferingListSearchParams } from "@/validation/product/offering-list.schema";

const mockFindList = vi.mocked(productOfferingRepository.findList);
const mockFindActiveValue = vi.mocked(systemConfigRepository.findActiveValue);

beforeEach(() => {
  mockFindList.mockReset();
  mockFindActiveValue.mockReset();
  mockFindList.mockResolvedValue({ rows: [], total: 0 });
});

function baseParams(
  overrides: Partial<OfferingListSearchParams> = {},
): OfferingListSearchParams {
  return {
    q: "",
    status: null,
    sort: "name",
    page: 1,
    offering: null,
    ...overrides,
  };
}

describe("listOfferings", () => {
  it("passes status: null through unchanged (repository owns the RETIRED exclusion)", async () => {
    mockFindActiveValue.mockResolvedValue("5");
    await listOfferings(baseParams({ status: null }));

    const [, filters] = mockFindList.mock.calls[0]!;
    expect(filters.status).toBeNull();
  });

  it("passes an explicit status through verbatim", async () => {
    mockFindActiveValue.mockResolvedValue("5");
    await listOfferings(baseParams({ status: "RETIRED" }));

    const [, filters] = mockFindList.mock.calls[0]!;
    expect(filters.status).toBe("RETIRED");
  });

  it("forwards q, sort, and page untouched", async () => {
    mockFindActiveValue.mockResolvedValue("5");
    await listOfferings(baseParams({ q: "5G", sort: "-name", page: 3 }));

    const [, filters] = mockFindList.mock.calls[0]!;
    expect(filters.q).toBe("5G");
    expect(filters.sort).toBe("-name");
    expect(filters.page).toBe(3);
  });

  describe("page-size resolution", () => {
    it.each([
      ["'5'", "5", 5],
      ["'25'", "25", 25],
      ["missing", null, DEFAULT_OFFERING_LIST_PAGE_SIZE],
      ["empty string", "", DEFAULT_OFFERING_LIST_PAGE_SIZE],
      ["'abc'", "abc", DEFAULT_OFFERING_LIST_PAGE_SIZE],
      ["'0'", "0", DEFAULT_OFFERING_LIST_PAGE_SIZE],
      ["'101'", "101", DEFAULT_OFFERING_LIST_PAGE_SIZE],
      ["'-5'", "-5", DEFAULT_OFFERING_LIST_PAGE_SIZE],
      ["'10.5'", "10.5", DEFAULT_OFFERING_LIST_PAGE_SIZE],
    ])("config %s resolves to %i", async (_label, configValue, expected) => {
      mockFindActiveValue.mockResolvedValue(configValue);

      const result = await listOfferings(baseParams());

      expect(result.pageSize).toBe(expected);
      const [, filters] = mockFindList.mock.calls[0]!;
      expect(filters.pageSize).toBe(expected);
    });
  });

  it("echoes page and resolved pageSize, carrying rows/total unmodified", async () => {
    mockFindActiveValue.mockResolvedValue("25");
    const rows = [
      {
        productOfferingId: "PRDOFR000001",
        name: "Offering A",
        lifecycleStatus: "ACTIVE" as const,
        version: 1,
        isSellable: true,
        billingOnly: false,
        lastModified: new Date("2026-01-01T00:00:00Z"),
        familyOfferingId: null,
      },
    ];
    mockFindList.mockResolvedValue({ rows, total: 42 });

    const result = await listOfferings(baseParams({ page: 2 }));

    expect(result).toEqual({ rows, total: 42, page: 2, pageSize: 25 });
  });
});
