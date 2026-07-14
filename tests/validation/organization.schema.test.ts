import { describe, expect, it } from "vitest";

import {
  organizationFieldsSchema,
  organizationIdSchema,
} from "@/validation/customer/organization.schema";

describe("organizationIdSchema", () => {
  it("accepts a well-formed ORG id", () => {
    expect(organizationIdSchema.safeParse("ORG0000001").success).toBe(true);
  });

  it("rejects a wrong-length numeric suffix", () => {
    expect(organizationIdSchema.safeParse("ORG1").success).toBe(false);
  });

  it("rejects a wrong prefix", () => {
    expect(organizationIdSchema.safeParse("PTRL00000001").success).toBe(false);
  });
});

describe("organizationFieldsSchema", () => {
  it("accepts minimal required fields, defaulting nullable optionals to null", () => {
    const result = organizationFieldsSchema.safeParse({
      name: "Acme Corp",
      organizationType: "COMPANY",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        name: "Acme Corp",
        tradingName: null,
        organizationType: "COMPANY",
        registrationNumber: null,
        taxId: null,
        industry: null,
      });
    }
  });

  it("trims string fields", () => {
    const result = organizationFieldsSchema.safeParse({
      name: "  Acme Corp  ",
      tradingName: "  Acme  ",
      organizationType: "COMPANY",
      registrationNumber: "  REG-1  ",
      taxId: "  TAX-1  ",
      industry: "  Telecom  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Acme Corp");
      expect(result.data.tradingName).toBe("Acme");
      expect(result.data.registrationNumber).toBe("REG-1");
      expect(result.data.taxId).toBe("TAX-1");
      expect(result.data.industry).toBe("Telecom");
    }
  });

  it("accepts explicit nulls for every optional field", () => {
    const result = organizationFieldsSchema.safeParse({
      name: "Acme Corp",
      tradingName: null,
      organizationType: "GOVERNMENT",
      registrationNumber: null,
      taxId: null,
      industry: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing name", () => {
    const result = organizationFieldsSchema.safeParse({
      organizationType: "COMPANY",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty name after trimming", () => {
    const result = organizationFieldsSchema.safeParse({
      name: "   ",
      organizationType: "COMPANY",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an organizationType outside COMPANY/GOVERNMENT", () => {
    const result = organizationFieldsSchema.safeParse({
      name: "Acme Corp",
      organizationType: "NONPROFIT",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a name over 200 characters", () => {
    const result = organizationFieldsSchema.safeParse({
      name: "a".repeat(201),
      organizationType: "COMPANY",
    });
    expect(result.success).toBe(false);
  });
});
