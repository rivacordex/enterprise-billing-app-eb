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
