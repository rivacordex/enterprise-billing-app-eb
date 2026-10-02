import { describe, expect, it } from "vitest";

import {
  flatRateDetailSchema,
  perUnitRateDetailSchema,
  udrRateDetailSchema,
} from "@/validation/rating/udr-rate-detail.schema";

import golden from "../fixtures/udr-rate-detail-golden.json";

// rm17-spec — PER_UNIT branch added to the udr_rate_detail discriminated
// union. Pure-function tests, no database.

const perUnit = (overrides: Record<string, unknown> = {}) => ({
  rateType: "PER_UNIT",
  ratePerUnit: "100.000000",
  quantity: "20",
  amountRaw: "2000.000000",
  ...overrides,
});

describe("flatRateDetailSchema", () => {
  it("parses the FLAT discriminant", () => {
    expect(flatRateDetailSchema.safeParse({ rateType: "FLAT" }).success).toBe(
      true,
    );
  });
});

describe("perUnitRateDetailSchema", () => {
  it("parses a valid PER_UNIT detail", () => {
    const result = perUnitRateDetailSchema.safeParse(perUnit());
    expect(result.success).toBe(true);
  });

  it("rejects an extra key", () => {
    const result = perUnitRateDetailSchema.safeParse(
      perUnit({ extra: "unexpected" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a missing field", () => {
    const { amountRaw: _amountRaw, ...rest } = perUnit();
    const result = perUnitRateDetailSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a number-typed (non-string) money field", () => {
    const result = perUnitRateDetailSchema.safeParse(
      perUnit({ ratePerUnit: 100 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a wrong discriminant", () => {
    const result = perUnitRateDetailSchema.safeParse(
      perUnit({ rateType: "FLAT" }),
    );
    expect(result.success).toBe(false);
  });
});

describe("udrRateDetailSchema", () => {
  it("rejects a PER_UNIT payload mislabelled FLAT (no silent strip)", () => {
    expect(
      udrRateDetailSchema.safeParse(perUnit({ rateType: "FLAT" })).success,
    ).toBe(false);
  });

  it("parses FLAT", () => {
    expect(udrRateDetailSchema.safeParse({ rateType: "FLAT" }).success).toBe(
      true,
    );
  });

  it("parses PER_UNIT", () => {
    expect(udrRateDetailSchema.safeParse(perUnit()).success).toBe(true);
  });

  it("rejects an unknown discriminant", () => {
    expect(
      udrRateDetailSchema.safeParse({ rateType: "TIERED_GRADUATED" }).success,
    ).toBe(false);
  });
});

describe("golden parity fixtures (shared with the rp.py mirror, rm19)", () => {
  for (const value of golden.valid) {
    it(`accepts ${JSON.stringify(value)}`, () => {
      expect(udrRateDetailSchema.safeParse(value).success).toBe(true);
    });
  }
  for (const { why, value } of golden.invalid) {
    it(`rejects: ${why}`, () => {
      expect(udrRateDetailSchema.safeParse(value).success).toBe(false);
    });
  }
});
