import { describe, expect, it } from "vitest";

import { priceInputSchema } from "@/validation/product/price-input.schema";

// pm47-spec D7 / guardrail 27 (Zod half). The discriminated price-input schema
// now discriminates on `componentType` (not the deleted `priceType`/
// `pricingModel` axis) and makes each component type carry exactly its own
// completeness columns: a recurring flat_fee a charge period (length ∈ 1/3/12,
// type `months`) and no unit; a usage_rate a unit from the closed, case-
// sensitive list and no period; a oneTime flat_fee neither. Money and steps
// live in the envelope `params`. Forbidden fields are rejected (strict
// branches), not stripped.

const USAGE_RATE = {
  componentType: "usage_rate" as const,
  unitOfMeasure: "GB" as const,
  name: "Per GB",
  currency: "USD",
  glCode: null,
  params: { ratePerUnit: "1.00", rateCardLookUp: null },
};

const FLAT_FEE_RECURRING = {
  componentType: "flat_fee" as const,
  priceType: "recurring" as const,
  recurringChargePeriodLength: 1,
  recurringChargePeriodType: "months" as const,
  name: "Monthly",
  currency: "USD",
  glCode: null,
  params: { amount: "50.00" },
};

const FLAT_FEE_ONE_TIME = {
  componentType: "flat_fee" as const,
  priceType: "oneTime" as const,
  name: "Setup fee",
  currency: "USD",
  glCode: null,
  params: { amount: "50.00" },
};

const CAPACITY_COMMITMENT = {
  componentType: "capacity_commitment" as const,
  unitOfMeasure: "GB" as const,
  name: "Committed capacity",
  currency: "USD",
  glCode: null,
  params: { committedQuantity: 1000 },
};

const CAPACITY_MOTIVATION = {
  componentType: "capacity_motivation" as const,
  unitOfMeasure: "GB" as const,
  name: "Volume discount",
  currency: "USD",
  glCode: null,
  params: {
    steps: [
      { aboveQuantity: 1000, ratePerUnit: "50" },
      { aboveQuantity: 2000, ratePerUnit: "25" },
    ],
  },
};

describe("priceInputSchema", () => {
  it("accepts a valid instance of each component type", () => {
    expect(priceInputSchema.safeParse(USAGE_RATE).success).toBe(true);
    expect(priceInputSchema.safeParse(FLAT_FEE_RECURRING).success).toBe(true);
    expect(priceInputSchema.safeParse(FLAT_FEE_ONE_TIME).success).toBe(true);
    expect(priceInputSchema.safeParse(CAPACITY_COMMITMENT).success).toBe(true);
    expect(priceInputSchema.safeParse(CAPACITY_MOTIVATION).success).toBe(true);
  });

  it("accepts every mapped recurring charge period (1, 3, 12 months)", () => {
    for (const length of [1, 3, 12]) {
      expect(
        priceInputSchema.safeParse({
          ...FLAT_FEE_RECURRING,
          recurringChargePeriodLength: length,
        }).success,
      ).toBe(true);
    }
  });

  it("accepts every unit of measure from the closed list", () => {
    for (const unit of ["Mbps", "GB", "MB", "EA"]) {
      expect(
        priceInputSchema.safeParse({ ...USAGE_RATE, unitOfMeasure: unit })
          .success,
      ).toBe(true);
    }
  });

  it("rejects a recurring flat_fee with no charge period", () => {
    const { recurringChargePeriodLength, recurringChargePeriodType, ...rest } =
      FLAT_FEE_RECURRING;
    void recurringChargePeriodLength;
    void recurringChargePeriodType;
    expect(priceInputSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a recurring charge period outside 1/3/12 (length 6)", () => {
    expect(
      priceInputSchema.safeParse({
        ...FLAT_FEE_RECURRING,
        recurringChargePeriodLength: 6,
      }).success,
    ).toBe(false);
  });

  it("rejects a recurring period type other than months ('years')", () => {
    expect(
      priceInputSchema.safeParse({
        ...FLAT_FEE_RECURRING,
        recurringChargePeriodType: "years",
      }).success,
    ).toBe(false);
  });

  it("rejects a recurring flat_fee that also carries a unit of measure", () => {
    expect(
      priceInputSchema.safeParse({ ...FLAT_FEE_RECURRING, unitOfMeasure: "GB" })
        .success,
    ).toBe(false);
  });

  it("rejects a usage_rate with no unit of measure", () => {
    const { unitOfMeasure, ...rest } = USAGE_RATE;
    void unitOfMeasure;
    expect(priceInputSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects usage units that differ only in case ('MBPS', 'gb'), never normalising them", () => {
    expect(
      priceInputSchema.safeParse({ ...USAGE_RATE, unitOfMeasure: "MBPS" })
        .success,
    ).toBe(false);
    expect(
      priceInputSchema.safeParse({ ...USAGE_RATE, unitOfMeasure: "gb" })
        .success,
    ).toBe(false);
  });

  it("rejects a usage_rate that also carries a charge period", () => {
    expect(
      priceInputSchema.safeParse({
        ...USAGE_RATE,
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
      }).success,
    ).toBe(false);
  });

  it("rejects a oneTime flat_fee carrying a charge period", () => {
    expect(
      priceInputSchema.safeParse({
        ...FLAT_FEE_ONE_TIME,
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
      }).success,
    ).toBe(false);
  });

  it("rejects a oneTime flat_fee carrying a unit of measure", () => {
    expect(
      priceInputSchema.safeParse({ ...FLAT_FEE_ONE_TIME, unitOfMeasure: "GB" })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown component type", () => {
    expect(
      priceInputSchema.safeParse({
        ...USAGE_RATE,
        componentType: "unknown_component",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown flat_fee price type", () => {
    expect(
      priceInputSchema.safeParse({ ...FLAT_FEE_ONE_TIME, priceType: "annual" })
        .success,
    ).toBe(false);
  });
});
