import { describe, expect, it } from "vitest";

import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";

describe("productSpecCharacteristicsSchema", () => {
  it("accepts a flat string record", () => {
    const result = productSpecCharacteristicsSchema.safeParse({
      SST_ID: "01",
      SD_ID: "A0C4E2",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object", () => {
    const result = productSpecCharacteristicsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects a non-string value", () => {
    const result = productSpecCharacteristicsSchema.safeParse({
      SST_ID: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty key", () => {
    const result = productSpecCharacteristicsSchema.safeParse({
      "": "value",
    });
    expect(result.success).toBe(false);
  });
});

// pm69-spec D5 / I4.11 (§1.55): all-digit names are refused because
// JavaScript hoists integer-like keys ahead of insertion order.
describe("productSpecCharacteristicsSchema — pm69 all-digit names", () => {
  it.each([{ "2": "x" }, { "02": "x" }])("rejects %j", (record) => {
    expect(productSpecCharacteristicsSchema.safeParse(record).success).toBe(
      false,
    );
  });

  it("accepts names that merely contain digits", () => {
    expect(
      productSpecCharacteristicsSchema.safeParse({
        SST_ID: "01",
        A1: "x",
        "2A": "y",
      }).success,
    ).toBe(true);
  });
});
