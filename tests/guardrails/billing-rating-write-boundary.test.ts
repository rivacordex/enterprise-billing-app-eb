import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// bm05-spec §Design/§Implementation §3 / bm13-spec §Design/§Implementation §2
// v1 adaptation, superseded bm16-spec §Implementation §5. `collect-claim.ts`
// (the v1 no-op that carried this guardrail) is retired — Collection is now
// the bill run PROCESSOR's stage (it claims `rating.udr_rated` itself, as
// `billrun_runtime`, per bm14's grant boundary), and `services/billing/
// handle-stage-signal.ts` records the processor's signal without touching
// `rating.*` at all (Fork B). This flips the guardrail's assertion from "no
// rating write exists" (true while there was no `rating` table) to "the only
// APP-SIDE `rating` write is `db/repositories/billing/udr-status.repository.ts`"
// — that file lands with bm17 (the app's own REJECT/BILL_APPROVED/RATED-release
// transitions, bm16-spec §3 Collection stub comment: "the app NEVER claims").
// Until then, this guardrail asserts NO app repository under
// `db/repositories/billing/` writes `rating.*` at all — the claim is
// exclusively the processor's, connected as `billrun_runtime` (bm14), never
// the app's `app_runtime`.
describe("billing-side rating.* write boundary (bm16-spec §Implementation §5)", () => {
  const REPO_DIR = resolve(process.cwd(), "db/repositories/billing");
  const SANCTIONED_WRITER = "udr-status.repository.ts";

  it("no db/repositories/billing/*.ts file issues a write against the rating schema (until udr-status.repository.ts lands, bm17)", () => {
    const files = readdirSync(REPO_DIR).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of files) {
      if (file === SANCTIONED_WRITER) continue; // not expected to exist yet
      const source = readFileSync(resolve(REPO_DIR, file), "utf8");
      // Any UPDATE/INSERT/DELETE targeting the rating schema, or a raw
      // reference to its tables, would be a write surface this repository
      // must not carry (Collection/claim moved to the processor, D5/T6).
      if (/rating\.udr_rated|"rating"\."udr_rated"|FROM\s+rating\./i.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no sanctioned rating-schema writer file yet (db/repositories/billing/udr-status.repository.ts, bm17)", () => {
    expect(existsSync(resolve(REPO_DIR, SANCTIONED_WRITER))).toBe(false);
  });

  it("services/billing/handle-stage-signal.ts imports nothing from db/schema/rating", () => {
    const source = readFileSync(
      resolve(process.cwd(), "services/billing/handle-stage-signal.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/db\/schema\/rating/);
  });
});
