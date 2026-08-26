import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// bm13-spec §Design/§Implementation §2 v1 adaptation — the "single rating
// writer / claim correctness" guardrail (billmgmt-code-standards.md §9.3) was
// INERT while there was no `rating` table: nothing to claim from, so no
// `rating.*` write could exist. rm01 (context/rating-management) has since
// shipped the `rating` schema for real, so the original "no rating export
// anywhere in db/schema" assertion is now expected to be false — that guard
// is retired. What still must hold on the *billing* side is unchanged:
// collectClaim's v1 no-op touches nothing in `rating`, and there is still no
// sanctioned writer — the bill run's claim path is a later billing unit
// (ratemgmt-project-overview.md "The bill run's claim path").
describe("no rating.* write exists on the billing side (bm13 v1 placeholder)", () => {
  it("collect-claim.ts imports nothing from db/schema/rating", () => {
    const source = readFileSync(
      resolve(process.cwd(), "services/billing/collect-claim.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/db\/schema\/rating/);
  });

  it("has no sanctioned rating-schema writer file (db/repositories/billing/rating-claim.ts)", () => {
    expect(
      existsSync(
        resolve(process.cwd(), "db/repositories/billing/rating-claim.ts"),
      ),
    ).toBe(false);
  });
});
