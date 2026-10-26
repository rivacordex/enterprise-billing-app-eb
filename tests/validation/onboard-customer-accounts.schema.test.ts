import { describe, expect, it } from "vitest";

import { onboardCustomerAccountsSchema } from "@/validation/accounts/onboard-customer-accounts.schema";

// cm23-spec D7 — templateTypeId admits only null or absent: a new BAN always
// starts on Standard, so any type id fails validation before the service.
const base = {
  partyRoleId: "PTRL00000001",
  billCycleId: "BCY000001",
  currency: "MYR",
  statusReason: "All KYC checks passed.",
  lastModifiedDatetime: new Date("2026-01-01T00:00:00.000Z"),
};

describe("onboardCustomerAccountsSchema — templateTypeId (cm23)", () => {
  it("parses when null", () => {
    const parsed = onboardCustomerAccountsSchema.safeParse({
      ...base,
      templateTypeId: null,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.templateTypeId).toBeNull();
  });

  it("parses when omitted", () => {
    const parsed = onboardCustomerAccountsSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.templateTypeId).toBeUndefined();
  });

  it.each(["BTF00000002", "BTF00000001", "BTV00000002", "bad"])(
    "rejects %s with a field error",
    (templateTypeId) => {
      const parsed = onboardCustomerAccountsSchema.safeParse({
        ...base,
        templateTypeId,
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.flatten().fieldErrors.templateTypeId).toHaveLength(
        1,
      );
    },
  );

  it("the old billTemplateVersionId key is not part of the schema", () => {
    const parsed = onboardCustomerAccountsSchema.safeParse({
      ...base,
      billTemplateVersionId: "BTV00000002",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("billTemplateVersionId");
  });
});
