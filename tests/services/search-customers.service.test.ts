import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/services/list-offerings.service.test.ts: mock @/db/client
// so importing the service never triggers lib/config's eager env
// validation.
vi.mock("@/db/client", () => ({ db: {} }));

vi.mock("@/db/repositories/party-role", () => ({
  partyRoleRepository: { searchByOrganizationNameOrTradingName: vi.fn() },
}));
vi.mock("@/db/repositories/system-config.repository", () => ({
  systemConfigRepository: { findActiveValue: vi.fn() },
}));

import { partyRoleRepository } from "@/db/repositories/party-role";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import {
  DEFAULT_CUSTOMER_SEARCH_RESULT_LIMIT,
  searchCustomers,
} from "@/services/customer/search-customers";

const mockSearch = vi.mocked(
  partyRoleRepository.searchByOrganizationNameOrTradingName,
);
const mockFindActiveValue = vi.mocked(systemConfigRepository.findActiveValue);

beforeEach(() => {
  mockSearch.mockReset();
  mockFindActiveValue.mockReset();
  mockSearch.mockResolvedValue([]);
});

function row(overrides: {
  partyRoleId: string;
  organizationId?: string;
  organizationStatus?: string;
  customerStatus?: string;
}) {
  return {
    partyRole: {
      partyRoleId: overrides.partyRoleId,
      status: overrides.customerStatus ?? "ACTIVE",
    } as never,
    organization: {
      organizationId: overrides.organizationId ?? "ORG0000001",
      name: "Acme Corp",
      tradingName: null,
      status: overrides.organizationStatus ?? "ACTIVE",
    } as never,
  };
}

describe("searchCustomers", () => {
  it("empty query short-circuits with no repository call", async () => {
    mockFindActiveValue.mockResolvedValue("5");

    const result = await searchCustomers("");

    expect(result).toEqual({
      results: [],
      hasMore: false,
      limit: 5,
      query: "",
    });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("whitespace-only query short-circuits with no repository call", async () => {
    mockFindActiveValue.mockResolvedValue("5");

    const result = await searchCustomers("   ");

    expect(result.results).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  describe("limit resolution", () => {
    it.each([
      ["'5'", "5", 5],
      ["'20'", "20", 20],
      ["missing", null, DEFAULT_CUSTOMER_SEARCH_RESULT_LIMIT],
      ["empty string", "", DEFAULT_CUSTOMER_SEARCH_RESULT_LIMIT],
      ["'abc'", "abc", DEFAULT_CUSTOMER_SEARCH_RESULT_LIMIT],
      ["'0'", "0", DEFAULT_CUSTOMER_SEARCH_RESULT_LIMIT],
      ["'-3'", "-3", DEFAULT_CUSTOMER_SEARCH_RESULT_LIMIT],
    ])("config %s resolves to %i", async (_label, configValue, expected) => {
      mockFindActiveValue.mockResolvedValue(configValue);

      const result = await searchCustomers("Acme");

      expect(result.limit).toBe(expected);
      const [, , limitArg] = mockSearch.mock.calls[0]!;
      expect(limitArg).toBe(expected + 1);
    });
  });

  it("hasMore is true and results are trimmed to limit when limit + 1 rows come back", async () => {
    mockFindActiveValue.mockResolvedValue("2");
    mockSearch.mockResolvedValue([
      row({ partyRoleId: "PTRL00000001" }),
      row({ partyRoleId: "PTRL00000002" }),
      row({ partyRoleId: "PTRL00000003" }),
    ]);

    const result = await searchCustomers("Acme");

    expect(result.hasMore).toBe(true);
    expect(result.results).toHaveLength(2);
  });

  it("hasMore is false when exactly limit rows come back", async () => {
    mockFindActiveValue.mockResolvedValue("2");
    mockSearch.mockResolvedValue([
      row({ partyRoleId: "PTRL00000001" }),
      row({ partyRoleId: "PTRL00000002" }),
    ]);

    const result = await searchCustomers("Acme");

    expect(result.hasMore).toBe(false);
    expect(result.results).toHaveLength(2);
  });

  it("escapes %, _, and \\ literally in the ILIKE pattern", async () => {
    mockFindActiveValue.mockResolvedValue("5");

    await searchCustomers("50%_off\\deal");

    const [, patternArg] = mockSearch.mock.calls[0]!;
    expect(patternArg).toBe("%50\\%\\_off\\\\deal%");
  });

  it("maps each row to a CustomerSearchResult and echoes the trimmed query", async () => {
    mockFindActiveValue.mockResolvedValue("5");
    mockSearch.mockResolvedValue([
      row({
        partyRoleId: "PTRL00000001",
        organizationId: "ORG0000001",
        organizationStatus: "SUSPENDED",
        customerStatus: "ACTIVE",
      }),
    ]);

    const result = await searchCustomers("  Acme  ");

    expect(result.query).toBe("Acme");
    expect(result.results[0]).toEqual({
      partyRoleId: "PTRL00000001",
      organizationId: "ORG0000001",
      organizationName: "Acme Corp",
      tradingName: null,
      organizationStatus: "SUSPENDED",
      customerStatus: "ACTIVE",
    });
  });
});
