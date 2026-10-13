import { describe, expect, it } from "vitest";

import {
  CUSTOMER_DETAIL_TABS,
  customerDetailSearchParamsSchema,
} from "@/validation/customer/search-params.schema";

// cm19-spec §3.4; cm20-spec §3.7 adds the lenient `page`; the cm20 review
// adds the lenient `fa` that scopes `page` to one Financial Account.
describe("customerDetailSearchParamsSchema", () => {
  it.each(CUSTOMER_DETAIL_TABS)("parses the valid tab %s", (tab) => {
    expect(customerDetailSearchParamsSchema.parse({ tab })).toEqual({
      tab,
      page: 1,
      fa: null,
    });
  });

  it("falls back to profile for an unknown tab", () => {
    expect(customerDetailSearchParamsSchema.parse({ tab: "bogus" })).toEqual({
      tab: "profile",
      page: 1,
      fa: null,
    });
  });

  it("falls back to profile when tab is undefined", () => {
    expect(customerDetailSearchParamsSchema.parse({ tab: undefined })).toEqual({
      tab: "profile",
      page: 1,
      fa: null,
    });
    expect(customerDetailSearchParamsSchema.parse({})).toEqual({
      tab: "profile",
      page: 1,
      fa: null,
    });
  });

  it("parses a numeric page", () => {
    expect(
      customerDetailSearchParamsSchema.parse({ tab: "accounts", page: "3" }),
    ).toEqual({ tab: "accounts", page: 3, fa: null });
  });

  it.each(["0", "-1", "abc", "1.5", "10000"])(
    "falls back to page 1 for %s",
    (page) => {
      expect(
        customerDetailSearchParamsSchema.parse({ tab: "accounts", page }).page,
      ).toBe(1);
    },
  );

  it("parses a Financial Account id for fa", () => {
    expect(
      customerDetailSearchParamsSchema.parse({
        tab: "accounts",
        fa: "FIN00000002",
      }).fa,
    ).toBe("FIN00000002");
  });

  it.each(["", "BAN00000001", "FIN", "fin00000001", "FIN1; DROP"])(
    "falls back to fa null for %j",
    (fa) => {
      expect(
        customerDetailSearchParamsSchema.parse({ tab: "accounts", fa }).fa,
      ).toBeNull();
    },
  );
});
