import { describe, expect, it } from "vitest";

import { rateCardListSearchParamsSchema } from "@/validation/product/ratecard-list.schema";

// pm65-spec I6 test 4/5 — the `/products/rate-card` search-param contract:
// parsed, never trusted (§3.17). A tampered or stale URL degrades to defaults;
// an unknown `tab` falls back to `rows`; a malformed `version` degrades to null
// (the page then renders the empty-selection state, not a 404).

describe("rateCardListSearchParamsSchema", () => {
  it("defaults an empty query to { version: null, page: 1, q: '', tab: 'rows' }", () => {
    expect(rateCardListSearchParamsSchema.parse({})).toEqual({
      version: null,
      page: 1,
      q: "",
      tab: "rows",
    });
  });

  it("accepts a well-formed RCV version id", () => {
    const parsed = rateCardListSearchParamsSchema.parse({
      version: "RCV00000007",
    });
    expect(parsed.version).toBe("RCV00000007");
  });

  it("degrades a malformed version id to null (never throws — empty-selection at the page)", () => {
    for (const bad of [
      "RCV123",
      "PRDOFR00000001",
      "not-an-id",
      "RCV000000012",
    ]) {
      expect(
        rateCardListSearchParamsSchema.parse({ version: bad }).version,
      ).toBe(null);
    }
  });

  it("coerces page and floors an out-of-range page to 1", () => {
    expect(rateCardListSearchParamsSchema.parse({ page: "3" }).page).toBe(3);
    expect(rateCardListSearchParamsSchema.parse({ page: "-3" }).page).toBe(1);
    expect(
      rateCardListSearchParamsSchema.parse({ page: "nonsense" }).page,
    ).toBe(1);
  });

  it("trims the row filter and caps it", () => {
    expect(rateCardListSearchParamsSchema.parse({ q: "  MNO-1  " }).q).toBe(
      "MNO-1",
    );
  });

  it("falls back an unknown tab to 'rows' (test 5)", () => {
    expect(rateCardListSearchParamsSchema.parse({ tab: "bogus" }).tab).toBe(
      "rows",
    );
    expect(
      rateCardListSearchParamsSchema.parse({ tab: "drop table" }).tab,
    ).toBe("rows");
  });

  it("keeps the three real tab values", () => {
    for (const tab of ["rows", "diff", "validation"] as const) {
      expect(rateCardListSearchParamsSchema.parse({ tab }).tab).toBe(tab);
    }
  });
});
