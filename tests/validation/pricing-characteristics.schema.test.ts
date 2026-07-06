import { describe, expect, it } from "vitest";

import {
  priceCharacteristicsSchema,
  tieredPricingCharacteristicsSchema,
} from "@/validation/product/pricing-characteristics.schema";

describe("tieredPricingCharacteristicsSchema", () => {
  it("accepts valid contiguous tiers with an open-ended top tier", () => {
    const result = tieredPricingCharacteristicsSchema.safeParse({
      tiers: [
        { from: 0, to: 1000, rate: "0.05" },
        { from: 1000, to: 10000, rate: "0.04" },
        { from: 10000, to: null, rate: "0.03" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a tier gap (to: 1000 then from: 1500)", () => {
    const result = tieredPricingCharacteristicsSchema.safeParse({
      tiers: [
        { from: 0, to: 1000, rate: "0.05" },
        { from: 1500, to: null, rate: "0.04" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tier overlap (to: 1000 then from: 500)", () => {
    const result = tieredPricingCharacteristicsSchema.safeParse({
      tiers: [
        { from: 0, to: 1000, rate: "0.05" },
        { from: 500, to: null, rate: "0.04" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects to <= from", () => {
    const result = tieredPricingCharacteristicsSchema.safeParse({
      tiers: [{ from: 1000, to: 1000, rate: "0.05" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects to: null on a non-last tier", () => {
    const result = tieredPricingCharacteristicsSchema.safeParse({
      tiers: [
        { from: 0, to: null, rate: "0.05" },
        { from: 1000, to: null, rate: "0.04" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative from", () => {
    const result = tieredPricingCharacteristicsSchema.safeParse({
      tiers: [{ from: -1, to: 1000, rate: "0.05" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty tiers array", () => {
    const result = tieredPricingCharacteristicsSchema.safeParse({ tiers: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric rate", () => {
    const result = tieredPricingCharacteristicsSchema.safeParse({
      tiers: [{ from: 0, to: null, rate: "abc" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("priceCharacteristicsSchema", () => {
  it("accepts a valid flat price", () => {
    const result = priceCharacteristicsSchema.safeParse({
      pricing_model: "flat",
      amount: "5000.00",
      pricing_characteristics: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid tiered price", () => {
    const result = priceCharacteristicsSchema.safeParse({
      pricing_model: "tiered",
      amount: null,
      pricing_characteristics: {
        tiers: [{ from: 0, to: null, rate: "0.05" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects flat with amount: null (XOR violation)", () => {
    const result = priceCharacteristicsSchema.safeParse({
      pricing_model: "flat",
      amount: null,
      pricing_characteristics: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects tiered with a non-null amount (XOR violation)", () => {
    const result = priceCharacteristicsSchema.safeParse({
      pricing_model: "tiered",
      amount: "5.00",
      pricing_characteristics: {
        tiers: [{ from: 0, to: null, rate: "0.05" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects tiered with pricing_characteristics: null (XOR violation)", () => {
    const result = priceCharacteristicsSchema.safeParse({
      pricing_model: "tiered",
      amount: null,
      pricing_characteristics: null,
    });
    expect(result.success).toBe(false);
  });
});
