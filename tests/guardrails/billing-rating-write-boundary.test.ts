import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// bm05-spec §Design/§Implementation §3 / bm13-spec §Design/§Implementation §2
// v1 adaptation, superseded bm16-spec §Implementation §5, flipped again by
// bm17-spec §Implementation §1. `collect-claim.ts` (the v1 no-op that carried
// this guardrail) was retired at bm16 — Collection is the bill run
// PROCESSOR's stage (it claims `rating.udr_rated` itself, as
// `billrun_runtime`, per bm14's grant boundary). bm17 lands the app's OWN
// sanctioned writer — `db/repositories/billing/udr-status.repository.ts`,
// the app's only `UPDATE rating.udr_rated` (the REJECT/BILL_APPROVED/
// RATED-release transitions at the human gates, bm16-spec §3 Collection stub
// comment: "the app NEVER claims"). This guardrail now asserts: every OTHER
// `db/repositories/billing/*.ts` file still carries NO `rating.*` write
// surface, and the sanctioned writer is exactly this one file.
describe("billing-side rating.* write boundary (bm17-spec §Implementation §1)", () => {
  const REPO_DIR = resolve(process.cwd(), "db/repositories/billing");
  const SANCTIONED_WRITER = "udr-status.repository.ts";

  function hasRatingWriteSurface(source: string): boolean {
    // Any UPDATE/INSERT/DELETE targeting the rating schema, or a raw
    // reference to its tables, is a write surface no OTHER file in this
    // directory may carry. An ORM-based write is an equally sanctioned
    // surface — a file that imports a rating table from db/schema/rating and
    // then calls .insert(/.update(/.delete( never emits the raw-SQL patterns
    // above, so it must be caught separately.
    const hasRawWrite =
      /rating\.udr_rated|"rating"\."udr_rated"|FROM\s+rating\./i.test(source);
    const hasOrmWrite =
      /from\s+["']@\/db\/schema\/rating/.test(source) &&
      /\.(insert|update|delete)\(/.test(source);
    return hasRawWrite || hasOrmWrite;
  }

  it("no db/repositories/billing/*.ts file OTHER THAN udr-status.repository.ts issues a write against the rating schema", () => {
    const files = readdirSync(REPO_DIR).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of files) {
      if (file === SANCTIONED_WRITER) continue;
      const source = readFileSync(resolve(REPO_DIR, file), "utf8");
      if (hasRatingWriteSurface(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("[CRITICAL] udr-status.repository.ts is the app's only sanctioned rating.udr_rated writer and exists", () => {
    const files = readdirSync(REPO_DIR).filter((f) => f.endsWith(".ts"));
    expect(files).toContain(SANCTIONED_WRITER);

    const source = readFileSync(resolve(REPO_DIR, SANCTIONED_WRITER), "utf8");
    expect(hasRatingWriteSurface(source)).toBe(true);
  });

  it("udr-status.repository.ts touches only the six claim columns (no INSERT, no other column)", () => {
    const source = readFileSync(
      resolve(REPO_DIR, SANCTIONED_WRITER),
      "utf8",
    );
    expect(source).not.toMatch(/\.insert\(/);
    // Every .set({...}) block may only assign these keys.
    const ALLOWED_KEYS = new Set([
      "status",
      "upsertDatetime",
      "billrunRefId",
      "billrunBanId",
      "billrunAttempt",
      "billrunChecksum",
    ]);
    const setBlocks = [...source.matchAll(/\.set\(\{([\s\S]*?)\}\)/g)];
    expect(setBlocks.length).toBeGreaterThan(0);
    for (const match of setBlocks) {
      const body = match[1] ?? "";
      const keys = [...body.matchAll(/(\w+):/g)].map((m) => m[1] ?? "");
      for (const key of keys) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
    }
  });

  it("services/billing/handle-stage-signal.ts imports nothing from db/schema/rating", () => {
    const source = readFileSync(
      resolve(process.cwd(), "services/billing/handle-stage-signal.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/db\/schema\/rating/);
  });
});
