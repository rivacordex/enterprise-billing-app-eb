import { describe, expect, it } from "vitest";

import { transitionCustomerStatusSchema } from "@/validation/customer/transition-customer-status.schema";

const VALID_INPUT = {
  partyRoleId: "PTRL00000001",
  targetStatus: "VALIDATED",
  statusReason: "Validation checks completed.",
  lastModifiedDatetime: "2026-01-01T00:00:00.000Z",
};

describe("transitionCustomerStatusSchema", () => {
  it("accepts a well-formed input", () => {
    const result = transitionCustomerStatusSchema.safeParse(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it("rejects a blank statusReason", () => {
    const result = transitionCustomerStatusSchema.safeParse({
      ...VALID_INPUT,
      statusReason: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only statusReason", () => {
    const result = transitionCustomerStatusSchema.safeParse({
      ...VALID_INPUT,
      statusReason: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a targetStatus outside the CustomerStatus enum", () => {
    const result = transitionCustomerStatusSchema.safeParse({
      ...VALID_INPUT,
      targetStatus: "NOT_A_STATUS",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed partyRoleId", () => {
    const result = transitionCustomerStatusSchema.safeParse({
      ...VALID_INPUT,
      partyRoleId: "not-a-party-role-id",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing lastModifiedDatetime", () => {
    const rest: Record<string, unknown> = { ...VALID_INPUT };
    delete rest.lastModifiedDatetime;
    const result = transitionCustomerStatusSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});
