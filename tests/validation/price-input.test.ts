import { describe, expect, it } from "vitest";

import { priceInputSchema } from "@/validation/product/price-input.schema";

// pm38-spec I7 / guardrail 27 (Zod half). The discriminated price-input schema
// makes each price type carry exactly its own completeness columns: a recurring
// price a charge period (length ∈ 1/3/12, type `months`) and no unit; a usage
// price a unit from the closed, case-sensitive list and no period; a `once`
// price neither. Forbidden fields are rejected (strict branches), not stripped.

const FLAT = {
  pricing_model: "flat" as const,
  amount: "50.00",
  pricing_characteristics: null,
};

const RECURRING = {
  priceType: "recurring" as const,
  recurringChargePeriodLength: 1,
  recurringChargePeriodType: "months" as const,
  name: "Monthly",
  currency: "USD",
  glCode: null,
  priceCharacteristics: FLAT,
};

const USAGE = {
  priceType: "usage" as const,
  unitOfMeasure: "GB" as const,
  name: "Per GB",
  currency: "USD",
  glCode: null,
  priceCharacteristics: FLAT,
};

const ONCE = {
  priceType: "once" as const,
  name: "Setup fee",
  currency: "USD",
  glCode: null,
  priceCharacteristics: FLAT,
};

describe("priceInputSchema", () => {
  it("accepts a valid instance of each price type", () => {
    expect(priceInputSchema.safeParse(RECURRING).success).toBe(true);
    expect(priceInputSchema.safeParse(USAGE).success).toBe(true);
    expect(priceInputSchema.safeParse(ONCE).success).toBe(true);
  });

  it("accepts every mapped recurring charge period (1, 3, 12 months)", () => {
    for (const length of [1, 3, 12]) {
      expect(
        priceInputSchema.safeParse({
          ...RECURRING,
          recurringChargePeriodLength: length,
        }).success,
      ).toBe(true);
    }
  });

  it("accepts every unit of measure from the closed list", () => {
    for (const unit of ["Mbps", "GB", "MB", "EA"]) {
      expect(
        priceInputSchema.safeParse({ ...USAGE, unitOfMeasure: unit }).success,
      ).toBe(true);
    }
  });

  it("rejects a recurring price with no charge period", () => {
    const { recurringChargePeriodLength, recurringChargePeriodType, ...rest } =
      RECURRING;
    void recurringChargePeriodLength;
    void recurringChargePeriodType;
    expect(priceInputSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a recurring charge period outside 1/3/12 (length 6)", () => {
    expect(
      priceInputSchema.safeParse({
        ...RECURRING,
        recurringChargePeriodLength: 6,
      }).success,
    ).toBe(false);
  });

  it("rejects a recurring period type other than months ('years')", () => {
    expect(
      priceInputSchema.safeParse({
        ...RECURRING,
        recurringChargePeriodType: "years",
      }).success,
    ).toBe(false);
  });

  it("rejects a recurring price that also carries a unit of measure", () => {
    expect(
      priceInputSchema.safeParse({ ...RECURRING, unitOfMeasure: "GB" }).success,
    ).toBe(false);
  });

  it("rejects a usage price with no unit of measure", () => {
    const { unitOfMeasure, ...rest } = USAGE;
    void unitOfMeasure;
    expect(priceInputSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects usage units that differ only in case ('MBPS', 'gb'), never normalising them", () => {
    expect(
      priceInputSchema.safeParse({ ...USAGE, unitOfMeasure: "MBPS" }).success,
    ).toBe(false);
    expect(
      priceInputSchema.safeParse({ ...USAGE, unitOfMeasure: "gb" }).success,
    ).toBe(false);
  });

  it("rejects a usage price that also carries a charge period", () => {
    expect(
      priceInputSchema.safeParse({
        ...USAGE,
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
      }).success,
    ).toBe(false);
  });

  it("rejects a once price carrying a charge period", () => {
    expect(
      priceInputSchema.safeParse({
        ...ONCE,
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
      }).success,
    ).toBe(false);
  });

  it("rejects a once price carrying a unit of measure", () => {
    expect(
      priceInputSchema.safeParse({ ...ONCE, unitOfMeasure: "GB" }).success,
    ).toBe(false);
  });

  it("rejects an unknown price type", () => {
    expect(
      priceInputSchema.safeParse({ ...ONCE, priceType: "annual" }).success,
    ).toBe(false);
  });
});
