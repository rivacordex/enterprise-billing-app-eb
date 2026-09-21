import { describe, expect, it } from "vitest";

import type {
  CapacityCommitmentComponent,
  CapacityMotivationComponent,
  UsageRateComponent,
} from "@/validation/product/pricing-component.schema";

// pm47-spec D9/I6. This is a TEST, not a product: a test-local pure function
// that reproduces, on paper, the arithmetic a later phase (Bill Run) will
// actually perform. Product defines and stores components; Bill Run prices
// them (Inv. #43) — nothing here is exported, imported by, or wired into any
// production module, and it must stay that way. Its only job is proving the
// worked figures the plan committed to are internally consistent with this
// unit's own envelope shapes, before any pricing engine exists to compute
// them for real.
//
// The model this function encodes: a `usage_rate` component prices every
// unit from zero up to the first `capacity_motivation` step's threshold at
// its own flat `ratePerUnit`; each subsequent step prices the band above its
// `aboveQuantity` threshold (up to the next step, or unbounded for the last)
// at that step's own rate; and `capacity_commitment` guarantees a *minimum*
// billable quantity — actual usage below the commitment is billed as if the
// full commitment were consumed, still walking the same per-band schedule
// (this is PC12's commitment-before-motivation ordering, and the reason the
// pipeline order is correct rather than coincidental: topping up from the
// commitment floor to actual usage must resume the SAME schedule at the
// commitment's own position, never restart it at zero).
function priceUsageComposition(input: {
  usageRate: UsageRateComponent;
  commitment: CapacityCommitmentComponent;
  motivation: CapacityMotivationComponent;
  actualQuantity: number;
}): number {
  const baseRate = Number(input.usageRate.params.ratePerUnit);
  const bands = [
    { from: 0, rate: baseRate },
    ...input.motivation.params.steps.map((step) => ({
      from: step.aboveQuantity,
      rate: Number(step.ratePerUnit),
    })),
  ];

  const billableQuantity = Math.max(
    input.actualQuantity,
    input.commitment.params.committedQuantity,
  );

  let total = 0;
  for (let i = 0; i < bands.length; i += 1) {
    const bandStart = bands[i]!.from;
    const bandEnd = i + 1 < bands.length ? bands[i + 1]!.from : Infinity;
    const unitsInBand = Math.max(
      0,
      Math.min(billableQuantity, bandEnd) - bandStart,
    );
    total += unitsInBand * bands[i]!.rate;
  }
  return total;
}

const usageRate: UsageRateComponent = {
  "@type": "usage_rate",
  specVersion: 1,
  plaSpecId: null,
  priceType: "usage",
  appliesAt: "rating",
  basis: "quantity",
  boundTo: { unitOfMeasure: "EA" },
  params: { ratePerUnit: "100", rateCardLookUp: null },
};

const commitment1000: CapacityCommitmentComponent = {
  "@type": "capacity_commitment",
  specVersion: 1,
  plaSpecId: "PLA_CAPACITY_COMMITMENT",
  priceType: "commitment",
  appliesAt: "post_aggregation",
  basis: "quantity",
  boundTo: { unitOfMeasure: "EA" },
  params: { committedQuantity: 1000 },
};

const twoBandMotivation: CapacityMotivationComponent = {
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
};

describe("pricing composition contract (reference arithmetic, exports nothing)", () => {
  it("800 EA (under the 1000 commitment) bills the committed floor: 100,000", () => {
    const total = priceUsageComposition({
      usageRate,
      commitment: commitment1000,
      motivation: twoBandMotivation,
      actualQuantity: 800,
    });
    expect(total).toBe(100_000);
  });

  it("2000 EA bills the floor plus the first @50 band: 150,000", () => {
    const total = priceUsageComposition({
      usageRate,
      commitment: commitment1000,
      motivation: twoBandMotivation,
      actualQuantity: 2000,
    });
    expect(total).toBe(150_000);
  });

  it("3000 EA bills the floor plus both bands, through the second @25 band: 175,000", () => {
    const total = priceUsageComposition({
      usageRate,
      commitment: commitment1000,
      motivation: twoBandMotivation,
      actualQuantity: 3000,
    });
    expect(total).toBe(175_000);
  });

  it("a commitment exceeding the first step's threshold still tops up through the same schedule", () => {
    // committedQuantity (1500) is itself past the first step's threshold
    // (1000) — the floor must price units 1000–1500 at the step-1 rate (50),
    // not the base rate, and actual usage above the commitment (1800) must
    // resume the SAME band (still ≤ 2000) rather than restart at zero or
    // jump to the next band. Floor: 1000·100 + 500·50 = 125,000. Top-up:
    // 300 more units still inside the @50 band = 15,000. Total: 140,000.
    const commitment1500: CapacityCommitmentComponent = {
      ...commitment1000,
      params: { committedQuantity: 1500 },
    };
    const total = priceUsageComposition({
      usageRate,
      commitment: commitment1500,
      motivation: twoBandMotivation,
      actualQuantity: 1800,
    });
    expect(total).toBe(140_000);
  });
});
