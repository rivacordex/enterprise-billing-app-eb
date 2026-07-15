import { describe, expect, it } from "vitest";

import { transitionOrganizationStatusSchema } from "@/validation/customer/transition-organization-status.schema";

const VALID_INPUT = {
  organizationId: "ORG0000001",
  partyRoleId: "PTRL00000001",
  targetStatus: "ACTIVE",
  statusReason: "Customer confirmed active trading.",
  lastModifiedDatetime: "2026-01-01T00:00:00.000Z",
};

describe("transitionOrganizationStatusSchema", () => {
  it("accepts a well-formed input", () => {
    const result = transitionOrganizationStatusSchema.safeParse(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it("rejects a blank statusReason", () => {
    const result = transitionOrganizationStatusSchema.safeParse({
      ...VALID_INPUT,
      statusReason: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only statusReason", () => {
    const result = transitionOrganizationStatusSchema.safeParse({
      ...VALID_INPUT,
      statusReason: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a targetStatus outside the OrganizationStatus enum", () => {
    const result = transitionOrganizationStatusSchema.safeParse({
      ...VALID_INPUT,
      targetStatus: "NOT_A_STATUS",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed organizationId", () => {
    const result = transitionOrganizationStatusSchema.safeParse({
      ...VALID_INPUT,
      organizationId: "not-an-org-id",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed partyRoleId", () => {
    const result = transitionOrganizationStatusSchema.safeParse({
      ...VALID_INPUT,
      partyRoleId: "not-a-party-role-id",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing lastModifiedDatetime", () => {
    const rest: Record<string, unknown> = { ...VALID_INPUT };
    delete rest.lastModifiedDatetime;
    const result = transitionOrganizationStatusSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});
