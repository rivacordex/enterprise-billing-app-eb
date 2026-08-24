import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { collectClaim } from "@/services/billing/collect-claim";
import * as schema from "@/db/schema";

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
// writer / claim correctness" guardrail (billmgmt-code-standards.md §9.3) is
// INERT in v1: there is no `rating` table, so there is nothing to claim from
// and no `rating.*` write can exist. This placeholder proves that emptiness
// structurally rather than assuming it, so it starts failing the moment a
// `rating` table, schema, or writer lands without this guardrail being
// revisited (architecture Inv. #2, pending the rating engine).
describe("no rating.* object exists or is written (bm13 v1 placeholder)", () => {
  it("declares no `rating` table/schema anywhere in db/schema", () => {
    const ratingExports = Object.keys(schema).filter((key) =>
      /rating/i.test(key),
    );
    expect(ratingExports).toEqual([]);
  });

  it("has no sanctioned rating-schema writer file (db/repositories/billing/rating-claim.ts)", () => {
    expect(
      existsSync(
        resolve(process.cwd(), "db/repositories/billing/rating-claim.ts"),
      ),
    ).toBe(false);
  });
});
