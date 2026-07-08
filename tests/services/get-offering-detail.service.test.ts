import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/services/roles-read.service.test.ts: mock `@/db/client` so
// importing the service never triggers `lib/config`'s eager env validation.
vi.mock("@/db/client", () => ({ db: {} }));

vi.mock("@/db/repositories/product-offering", () => ({
  productOfferingRepository: { findDetailById: vi.fn() },
}));
vi.mock("@/db/repositories/product-specification", () => ({
  productSpecificationRepository: { findByOfferingId: vi.fn() },
}));
vi.mock("@/db/repositories/product-offering-price", () => ({
  productOfferingPriceRepository: { findByOfferingIdWithDerivedEnd: vi.fn() },
}));

import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import { getOfferingDetail } from "@/services/product/get-offering-detail";

const mockFindDetailById = vi.mocked(productOfferingRepository.findDetailById);
const mockFindByOfferingId = vi.mocked(
  productSpecificationRepository.findByOfferingId,
);
const mockFindByOfferingIdWithDerivedEnd = vi.mocked(
  productOfferingPriceRepository.findByOfferingIdWithDerivedEnd,
);

const OFFERING = {
  productOfferingId: "PRDOFR000001",
  name: "5G Nationwide",
  isBundle: false,
  isSellable: true,
  billingOnly: false,
  lifecycleStatus: "ACTIVE" as const,
  version: 1,
  lastModified: new Date("2026-01-01T00:00:00Z"),
  lastEditedByName: null,
};

const NOW = new Date("2026-07-04T00:00:00Z");

function priceRow(
  overrides: { startDateTime?: Date; endDateTime?: Date | null } = {},
) {
  return {
    productOfferingPriceId: "PRDOFP000001",
    name: "Monthly Recurring Charge",
    priceType: "recurring" as const,
    pricingModel: "flat" as const,
    amount: "5000.00",
    currency: "MYR",
    recurringChargePeriodLength: 1,
    recurringChargePeriodType: "months",
    unitOfMeasure: null,
    glCode: "GL-4100",
    policy: null,
    pricingCharacteristics: null,
    startDateTime: overrides.startDateTime ?? new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    endDateTime: overrides.endDateTime ?? null,
  };
}

beforeEach(() => {
  mockFindDetailById.mockReset();
  mockFindByOfferingId.mockReset();
  mockFindByOfferingIdWithDerivedEnd.mockReset();
});

describe("getOfferingDetail", () => {
  it("returns null for an unknown ID and never calls the spec/price finders", async () => {
    mockFindDetailById.mockResolvedValue(null);

    const result = await getOfferingDetail("PRDOFR999999", NOW);

    expect(result).toBeNull();
    expect(mockFindByOfferingId).not.toHaveBeenCalled();
    expect(mockFindByOfferingIdWithDerivedEnd).not.toHaveBeenCalled();
  });

  describe("effectivity status", () => {
    it("marks a price current when start <= now < end", async () => {
      mockFindDetailById.mockResolvedValue(OFFERING);
      mockFindByOfferingId.mockResolvedValue([]);
      mockFindByOfferingIdWithDerivedEnd.mockResolvedValue([
        priceRow({
          startDateTime: new Date("2026-01-01T00:00:00Z"),
          endDateTime: new Date("2027-01-01T00:00:00Z"),
        }),
      ]);

      const result = await getOfferingDetail("PRDOFR000001", NOW);
      expect(result?.prices[0]?.effectivityStatus).toBe("current");
    });

    it("marks a future-dated successor future without displacing the current price", async () => {
      mockFindDetailById.mockResolvedValue(OFFERING);
      mockFindByOfferingId.mockResolvedValue([]);
      mockFindByOfferingIdWithDerivedEnd.mockResolvedValue([
        priceRow({
          startDateTime: new Date("2026-01-01T00:00:00Z"),
          endDateTime: new Date("2027-01-01T00:00:00Z"),
        }),
        priceRow({
          startDateTime: new Date("2027-01-01T00:00:00Z"),
          endDateTime: null,
        }),
      ]);

      const result = await getOfferingDetail("PRDOFR000001", NOW);
      expect(result?.prices[0]?.effectivityStatus).toBe("current");
      expect(result?.prices[1]?.effectivityStatus).toBe("future");
      expect(result?.prices[1]?.endDateTime).toBeNull();
    });

    it("marks a superseded price superseded", async () => {
      mockFindDetailById.mockResolvedValue(OFFERING);
      mockFindByOfferingId.mockResolvedValue([]);
      mockFindByOfferingIdWithDerivedEnd.mockResolvedValue([
        priceRow({
          startDateTime: new Date("2025-01-01T00:00:00Z"),
          endDateTime: new Date("2026-01-01T00:00:00Z"),
        }),
      ]);

      const result = await getOfferingDetail("PRDOFR000001", NOW);
      expect(result?.prices[0]?.effectivityStatus).toBe("superseded");
    });

    it("boundary: now === start is current", async () => {
      mockFindDetailById.mockResolvedValue(OFFERING);
      mockFindByOfferingId.mockResolvedValue([]);
      mockFindByOfferingIdWithDerivedEnd.mockResolvedValue([
        priceRow({ startDateTime: NOW, endDateTime: null }),
      ]);

      const result = await getOfferingDetail("PRDOFR000001", NOW);
      expect(result?.prices[0]?.effectivityStatus).toBe("current");
    });

    it("boundary: now === endDateTime is superseded (window [start, successorStart))", async () => {
      mockFindDetailById.mockResolvedValue(OFFERING);
      mockFindByOfferingId.mockResolvedValue([]);
      mockFindByOfferingIdWithDerivedEnd.mockResolvedValue([
        priceRow({
          startDateTime: new Date("2026-01-01T00:00:00Z"),
          endDateTime: NOW,
        }),
      ]);

      const result = await getOfferingDetail("PRDOFR000001", NOW);
      expect(result?.prices[0]?.effectivityStatus).toBe("superseded");
    });

    it("an open-ended started price is current with endDateTime: null", async () => {
      mockFindDetailById.mockResolvedValue(OFFERING);
      mockFindByOfferingId.mockResolvedValue([]);
      mockFindByOfferingIdWithDerivedEnd.mockResolvedValue([
        priceRow({
          startDateTime: new Date("2026-01-01T00:00:00Z"),
          endDateTime: null,
        }),
      ]);

      const result = await getOfferingDetail("PRDOFR000001", NOW);
      expect(result?.prices[0]?.endDateTime).toBeNull();
      expect(result?.prices[0]?.effectivityStatus).toBe("current");
    });
  });

  it("assembles specifications and prices from the mocked finders in order; lastEditedByName null passes through", async () => {
    mockFindDetailById.mockResolvedValue(OFFERING);
    const specs = [
      {
        productSpecId: "PRDSMD000001",
        name: "Network Slice",
        isMandatory: true,
        isDefault: true,
        defaultValue: null,
        characteristics: { SST_ID: "01" },
      },
    ];
    mockFindByOfferingId.mockResolvedValue(specs);
    mockFindByOfferingIdWithDerivedEnd.mockResolvedValue([priceRow()]);

    const result = await getOfferingDetail("PRDOFR000001", NOW);

    expect(result?.lastEditedByName).toBeNull();
    expect(result?.specifications).toEqual(specs);
    expect(result?.prices).toHaveLength(1);
    expect(result?.prices[0]?.productOfferingPriceId).toBe("PRDOFP000001");
  });
});
