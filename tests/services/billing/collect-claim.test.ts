import { describe, expect, it } from "vitest";

import { collectClaim } from "@/services/billing/collect-claim";

// bm05-spec §Design/§Implementation §3 — the v1 no-op: always DONE, no
// error, no rating-schema write of any kind.
describe("collectClaim (bm05-spec §3)", () => {
  it("always returns DONE with no error", () => {
    expect(collectClaim()).toEqual({
      status: "DONE",
      errorClass: null,
      errorCode: null,
      errorDetail: null,
    });
  });

  it("is a pure, deterministic no-op across repeated calls", () => {
    expect(collectClaim()).toEqual(collectClaim());
  });
});
