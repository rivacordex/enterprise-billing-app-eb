import { describe, expect, it } from "vitest";

import {
  capacityCommitmentComponentSchema,
  capacityMotivationComponentSchema,
  flatFeeComponentSchema,
  negotiatedOverrideComponentSchema,
  persistablePricingComponentSchema,
  pricingComponentSchema,
  stepsSchema,
  usageRateComponentSchema,
} from "@/validation/product/pricing-component.schema";
import { COMPONENT_TYPES, type ComponentType } from "@/types/product";

// pm47-spec I5. Pure-function tests, no database — proves Zod refuses exactly
// what pm46's CHECKs independently refuse (guardrail 32, Inv. #31/#32).

const usageRate = (overrides: Record<string, unknown> = {}) => ({
  "@type": "usage_rate",
  specVersion: 1,
  plaSpecId: null,
  priceType: "usage",
  appliesAt: "rating",
  basis: "quantity",
  boundTo: { unitOfMeasure: "EA" },
  params: { ratePerUnit: "100", rateCardLookUp: null },
  ...overrides,
});

const flatFeeRecurring = (overrides: Record<string, unknown> = {}) => ({
  "@type": "flat_fee",
  specVersion: 1,
  plaSpecId: null,
  priceType: "recurring",
  appliesAt: "billing",
  basis: "flat",
  boundTo: null,
  params: { amount: "5000" },
  ...overrides,
});

const flatFeeOneTime = (overrides: Record<string, unknown> = {}) => ({
  "@type": "flat_fee",
  specVersion: 1,
  plaSpecId: null,
  priceType: "oneTime",
  appliesAt: "billing",
  basis: "flat",
  boundTo: null,
  params: { amount: "250" },
  ...overrides,
});

const capacityCommitment = (overrides: Record<string, unknown> = {}) => ({
  "@type": "capacity_commitment",
  specVersion: 1,
  plaSpecId: "PLA_CAPACITY_COMMITMENT",
  priceType: "commitment",
  appliesAt: "post_aggregation",
  basis: "quantity",
  boundTo: { unitOfMeasure: "EA" },
  params: { committedQuantity: 1000 },
  ...overrides,
});

const capacityMotivationOneBand = (
  overrides: Record<string, unknown> = {},
) => ({
  "@type": "capacity_motivation",
  specVersion: 1,
  plaSpecId: "PLA_CAPACITY_MOTIVATION",
  priceType: "discount",
  appliesAt: "post_aggregation",
  basis: "quantity",
  boundTo: { unitOfMeasure: "EA" },
  params: { steps: [{ aboveQuantity: 1000, ratePerUnit: "50" }] },
  ...overrides,
});

const capacityMotivationTwoBand = (
  overrides: Record<string, unknown> = {},
) => ({
  "@type": "capacity_motivation",
  specVersion: 1,
  plaSpecId: "PLA_CAPACITY_MOTIVATION",
  priceType: "discount",
  appliesAt: "post_aggregation",
  basis: "quantity",
  boundTo: { unitOfMeasure: "EA" },
  params: {
    steps: [
      { aboveQuantity: 1000, ratePerUnit: "50" },
      { aboveQuantity: 2000, ratePerUnit: "25" },
    ],
  },
  ...overrides,
});

const negotiatedOverride = (overrides: Record<string, unknown> = {}) => ({
  "@type": "negotiated_override",
  specVersion: 1,
  plaSpecId: null,
  priceType: "discount",
  appliesAt: "rating",
  basis: "quantity",
  boundTo: { priceType: "usage", unitOfMeasure: "EA" },
  params: { ratePerUnit: "85" },
  ...overrides,
});

describe("pricingComponentSchema — worked envelopes parse", () => {
  it("parses the usage_rate '100' EA envelope", () => {
    expect(pricingComponentSchema.safeParse(usageRate()).success).toBe(true);
  });

  it("parses the recurring flat_fee envelope", () => {
    expect(pricingComponentSchema.safeParse(flatFeeRecurring()).success).toBe(
      true,
    );
  });

  it("parses the oneTime flat_fee envelope", () => {
    expect(pricingComponentSchema.safeParse(flatFeeOneTime()).success).toBe(
      true,
    );
  });

  it("parses the capacity_commitment 1000 envelope", () => {
    expect(pricingComponentSchema.safeParse(capacityCommitment()).success).toBe(
      true,
    );
  });

  it("parses the one-band capacity_motivation envelope", () => {
    expect(
      pricingComponentSchema.safeParse(capacityMotivationOneBand()).success,
    ).toBe(true);
  });

  it("parses the two-band capacity_motivation envelope", () => {
    expect(
      pricingComponentSchema.safeParse(capacityMotivationTwoBand()).success,
    ).toBe(true);
  });

  it("parses the negotiated_override '85' envelope", () => {
    expect(pricingComponentSchema.safeParse(negotiatedOverride()).success).toBe(
      true,
    );
  });
});

describe("pricingComponentSchema — refusals", () => {
  it("rejects an empty steps array", () => {
    const result = pricingComponentSchema.safeParse(
      capacityMotivationOneBand({ params: { steps: [] } }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects descending steps, naming the offending index", () => {
    const result = pricingComponentSchema.safeParse(
      capacityMotivationTwoBand({
        params: {
          steps: [
            { aboveQuantity: 2000, ratePerUnit: "50" },
            { aboveQuantity: 1000, ratePerUnit: "25" },
          ],
        },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([
        "params",
        "steps",
        1,
        "aboveQuantity",
      ]);
    }
  });

  it("rejects duplicate thresholds", () => {
    const result = pricingComponentSchema.safeParse(
      capacityMotivationTwoBand({
        params: {
          steps: [
            { aboveQuantity: 1000, ratePerUnit: "50" },
            { aboveQuantity: 1000, ratePerUnit: "25" },
          ],
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects aboveQuantity: 0", () => {
    const result = pricingComponentSchema.safeParse(
      capacityMotivationOneBand({
        params: { steps: [{ aboveQuantity: 0, ratePerUnit: "50" }] },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a step ratePerUnit as a number", () => {
    const result = pricingComponentSchema.safeParse(
      capacityMotivationOneBand({
        params: { steps: [{ aboveQuantity: 1000, ratePerUnit: 50 }] },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects amount as a number", () => {
    const result = pricingComponentSchema.safeParse(
      flatFeeOneTime({ params: { amount: 250 } }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects committedQuantity: 0", () => {
    expect(
      pricingComponentSchema.safeParse(
        capacityCommitment({ params: { committedQuantity: 0 } }),
      ).success,
    ).toBe(false);
  });

  it("rejects committedQuantity: -1", () => {
    expect(
      pricingComponentSchema.safeParse(
        capacityCommitment({ params: { committedQuantity: -1 } }),
      ).success,
    ).toBe(false);
  });

  it("rejects committedQuantity as a string", () => {
    expect(
      pricingComponentSchema.safeParse(
        capacityCommitment({ params: { committedQuantity: "1000" } }),
      ).success,
    ).toBe(false);
  });

  it("rejects committedQuantity: Infinity", () => {
    expect(
      pricingComponentSchema.safeParse(
        capacityCommitment({ params: { committedQuantity: Infinity } }),
      ).success,
    ).toBe(false);
  });

  it("rejects a usage_rate with a rateCardLookUp but plaSpecId: null", () => {
    const result = pricingComponentSchema.safeParse(
      usageRate({
        plaSpecId: null,
        params: { ratePerUnit: "100", rateCardLookUp: "CARD-1" },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a usage_rate with no card but plaSpecId: 'PLA_USAGE_RATE'", () => {
    const result = pricingComponentSchema.safeParse(
      usageRate({
        plaSpecId: "PLA_USAGE_RATE",
        params: { ratePerUnit: "100", rateCardLookUp: null },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a missing specVersion", () => {
    const { specVersion: _specVersion, ...rest } = usageRate();
    expect(pricingComponentSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects specVersion: 2", () => {
    expect(
      pricingComponentSchema.safeParse(usageRate({ specVersion: 2 })).success,
    ).toBe(false);
  });

  it.each([
    ["usage_rate", usageRate()],
    ["flat_fee", flatFeeOneTime()],
    ["capacity_commitment", capacityCommitment()],
    ["capacity_motivation", capacityMotivationOneBand()],
    ["negotiated_override", negotiatedOverride()],
  ])("rejects an unknown key on the %s branch", (_label, valid) => {
    const result = pricingComponentSchema.safeParse({
      ...valid,
      unknownField: "oops",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a @type outside the five", () => {
    const result = pricingComponentSchema.safeParse(
      usageRate({ "@type": "subscription_fee" }),
    );
    expect(result.success).toBe(false);
  });
});

describe("persistablePricingComponentSchema", () => {
  it("rejects negotiated_override while pricingComponentSchema accepts it", () => {
    const override = negotiatedOverride();
    expect(pricingComponentSchema.safeParse(override).success).toBe(true);
    expect(persistablePricingComponentSchema.safeParse(override).success).toBe(
      false,
    );
  });

  it("still accepts every persistable branch", () => {
    expect(
      persistablePricingComponentSchema.safeParse(usageRate()).success,
    ).toBe(true);
    expect(
      persistablePricingComponentSchema.safeParse(flatFeeRecurring()).success,
    ).toBe(true);
    expect(
      persistablePricingComponentSchema.safeParse(capacityCommitment()).success,
    ).toBe(true);
    expect(
      persistablePricingComponentSchema.safeParse(capacityMotivationOneBand())
        .success,
    ).toBe(true);
  });
});

describe("ComponentType", () => {
  it("has exactly four members and excludes negotiated_override", () => {
    expect(COMPONENT_TYPES).toHaveLength(4);
    expect(COMPONENT_TYPES).not.toContain("negotiated_override");

    // Compile-time proof that 'negotiated_override' is not assignable to
    // ComponentType (pm47-spec D3) — this line only type-checks if the
    // assignment below is rejected by tsc.
    // @ts-expect-error negotiated_override is not a member of ComponentType
    const _notAComponentType: ComponentType = "negotiated_override";
    void _notAComponentType;
  });
});

describe("individual branch schemas", () => {
  it("usageRateComponentSchema/flatFeeComponentSchema/capacityCommitmentComponentSchema/capacityMotivationComponentSchema/negotiatedOverrideComponentSchema each parse their own shape", () => {
    expect(usageRateComponentSchema.safeParse(usageRate()).success).toBe(true);
    expect(flatFeeComponentSchema.safeParse(flatFeeOneTime()).success).toBe(
      true,
    );
    expect(
      capacityCommitmentComponentSchema.safeParse(capacityCommitment()).success,
    ).toBe(true);
    expect(
      capacityMotivationComponentSchema.safeParse(capacityMotivationOneBand())
        .success,
    ).toBe(true);
    expect(
      negotiatedOverrideComponentSchema.safeParse(negotiatedOverride()).success,
    ).toBe(true);
  });
});

describe("stepsSchema", () => {
  it("accepts a single ascending step", () => {
    expect(
      stepsSchema.safeParse([{ aboveQuantity: 1000, ratePerUnit: "50" }])
        .success,
    ).toBe(true);
  });
});
