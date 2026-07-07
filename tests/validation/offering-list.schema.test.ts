import { describe, expect, it } from "vitest";

import { offeringListSearchParamsSchema } from "@/validation/product/offering-list.schema";

describe("offeringListSearchParamsSchema", () => {
  it("falls back to defaults when every field is garbage", () => {
    const result = offeringListSearchParamsSchema.parse({
      q: 12345,
      status: "NOT_A_STATUS",
      sort: "not_a_sort",
      page: "not-a-number",
      offering: "not-an-offering-id",
    });
    expect(result).toEqual({
      q: "",
      status: null,
      sort: "name",
      page: 1,
      offering: null,
    });
  });

  it("falls back to defaults for a bare object", () => {
    const result = offeringListSearchParamsSchema.parse({});
    expect(result).toEqual({
      q: "",
      status: null,
      sort: "name",
      page: 1,
      offering: null,
    });
  });

  it("passes through valid values", () => {
    const result = offeringListSearchParamsSchema.parse({
      q: "5G",
      status: "ACTIVE",
      sort: "-last_modified",
      page: "3",
      offering: "PRDOFR000001",
    });
    expect(result).toEqual({
      q: "5G",
      status: "ACTIVE",
      sort: "-last_modified",
      page: 3,
      offering: "PRDOFR000001",
    });
  });

  it("accepts a well-formed offering ID", () => {
    const result = offeringListSearchParamsSchema.parse({
      offering: "PRDOFR000001",
    });
    expect(result.offering).toBe("PRDOFR000001");
  });

  it("rejects a short numeric suffix (PRDOFR1)", () => {
    const result = offeringListSearchParamsSchema.parse({
      offering: "PRDOFR1",
    });
    expect(result.offering).toBeNull();
  });

  it("rejects a wrong-prefix ID (PRDSMD000001)", () => {
    const result = offeringListSearchParamsSchema.parse({
      offering: "PRDSMD000001",
    });
    expect(result.offering).toBeNull();
  });

  it("rejects an injection string", () => {
    const result = offeringListSearchParamsSchema.parse({
      offering: "PRDOFR000001' OR '1'='1",
    });
    expect(result.offering).toBeNull();
  });
});
