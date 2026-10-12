import { describe, expect, it } from "vitest";

import { onboardCustomerAccountsSchema } from "@/validation/accounts/onboard-customer-accounts.schema";

// cm18-spec §3.2 — billTemplateVersionId accepts null, omitted or a
// well-formed BTV id; the NULL-only rule lives in assertBindableTemplate.
const base = {
  partyRoleId: "PTRL00000001",
  billCycleId: "BCY000001",
  currency: "MYR",
  statusReason: "All KYC checks passed.",
  lastModifiedDatetime: new Date("2026-01-01T00:00:00.000Z"),
};

describe("onboardCustomerAccountsSchema — billTemplateVersionId (cm18)", () => {
  it("parses when null", () => {
    const parsed = onboardCustomerAccountsSchema.safeParse({
      ...base,
      billTemplateVersionId: null,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.billTemplateVersionId).toBeNull();
  });

  it("parses when omitted", () => {
    const parsed = onboardCustomerAccountsSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.billTemplateVersionId).toBeUndefined();
  });

  it("parses a well-formed id", () => {
    const parsed = onboardCustomerAccountsSchema.safeParse({
      ...base,
      billTemplateVersionId: "BTV00000002",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a malformed id with a field error", () => {
    const parsed = onboardCustomerAccountsSchema.safeParse({
      ...base,
      billTemplateVersionId: "bad",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.flatten().fieldErrors.billTemplateVersionId).toEqual([
      "Invalid template version ID",
    ]);
  });
});
