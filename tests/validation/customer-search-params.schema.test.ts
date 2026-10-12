import { describe, expect, it } from "vitest";

import {
  CUSTOMER_DETAIL_TABS,
  customerDetailSearchParamsSchema,
} from "@/validation/customer/search-params.schema";

// cm19-spec §3.4.
describe("customerDetailSearchParamsSchema", () => {
  it.each(CUSTOMER_DETAIL_TABS)("parses the valid tab %s", (tab) => {
    expect(customerDetailSearchParamsSchema.parse({ tab })).toEqual({ tab });
  });

  it("falls back to profile for an unknown tab", () => {
    expect(customerDetailSearchParamsSchema.parse({ tab: "bogus" })).toEqual({
      tab: "profile",
    });
  });

  it("falls back to profile when tab is undefined", () => {
    expect(customerDetailSearchParamsSchema.parse({ tab: undefined })).toEqual({
      tab: "profile",
    });
    expect(customerDetailSearchParamsSchema.parse({})).toEqual({
      tab: "profile",
    });
  });
});
