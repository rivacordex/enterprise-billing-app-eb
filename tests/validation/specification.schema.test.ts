import { describe, expect, it } from "vitest";

import {
  parseSpecificationInput,
  specificationSchema,
} from "@/validation/customer/specification.schema";

describe("specificationSchema", () => {
  it("accepts an empty object", () => {
    expect(specificationSchema.safeParse({}).success).toBe(true);
  });

  it("accepts an object with arbitrary keys and values", () => {
    const result = specificationSchema.safeParse({
      CUST_TYPE: "ENTERPRISE",
      PARTY_TYPE: "COMPANY",
      CUST_KEY: 12345,
      nested: { a: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a top-level array", () => {
    expect(specificationSchema.safeParse([1, 2, 3]).success).toBe(false);
  });

  it.each([
    ["string", "not-an-object"],
    ["number", 42],
    ["boolean", true],
    ["null", null],
  ])("rejects a top-level %s", (_label, value) => {
    expect(specificationSchema.safeParse(value).success).toBe(false);
  });
});

describe("parseSpecificationInput", () => {
  it("accepts well-formed JSON object text, including {}", () => {
    expect(parseSpecificationInput("{}")).toEqual({ ok: true, value: {} });
    expect(parseSpecificationInput('{"CUST_TYPE":"ENTERPRISE"}')).toEqual({
      ok: true,
      value: { CUST_TYPE: "ENTERPRISE" },
    });
  });

  it("rejects invalid JSON text", () => {
    expect(parseSpecificationInput("{not json")).toEqual({ ok: false });
  });

  it("rejects a top-level JSON array", () => {
    expect(parseSpecificationInput("[1,2,3]")).toEqual({ ok: false });
  });

  it.each([
    ["string", '"hello"'],
    ["number", "42"],
    ["boolean", "true"],
    ["null", "null"],
  ])("rejects a top-level JSON %s", (_label, raw) => {
    expect(parseSpecificationInput(raw)).toEqual({ ok: false });
  });
});
