import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// rm29-spec §3 — the raw-key grep gate (Inv 27; workflow-rules §0.1 rules 7,
// 24, 30). No key value may be normalised in the rating runtime (PRP, RP, RL),
// the sample seeds or the shared test helpers. A pure filesystem/text scan, run
// in the default (DB-free) vitest project, so CI fails on a regression.
//
// The diff half of §3 (no file under db/migrations/** or db/bootstrap/**, no
// new udr_rated column, no billing file) is checked against the unit's base:
//   git diff --name-only <base> -- db/migrations db/bootstrap \
//     db/schema/rating/udr-rated.ts services/billing db/repositories/billing \
//     db/schema/billing
// must print nothing.

const ROOT = process.cwd();
const RUNTIME = join(
  ROOT,
  "workflow-management/worker/workflow-engine/runtime",
);
const SCANNED = [
  join(RUNTIME, "prp.py"),
  join(RUNTIME, "rp.py"),
  join(RUNTIME, "rl.py"),
  join(ROOT, "db/seeds/sample"),
  join(ROOT, "tests/helpers"),
];

const FORBIDDEN =
  /casefold|\.lower\(|\.toLowerCase\(|canonical_udr_key|_normalise_value/;

// Lower-casing that never touches a key value (spec §3: "unrelated
// lower-casing is allowed"). Each entry names the file and why.
const ALLOWED: Record<string, string> = {
  // Lower-cases a blob-store connection-string field, not a udr_key.
  "tests/helpers/assert-test-blob-store.ts": "connection-string parsing",
};

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

function hits(): string[] {
  return SCANNED.flatMap(files)
    .filter((f) => /\.(py|ts)$/.test(f))
    .flatMap((f) => {
      const rel = relative(ROOT, f).split("\\").join("/");
      if (rel in ALLOWED) return [];
      return readFileSync(f, "utf8")
        .split(/\r?\n/)
        .flatMap((line, i) =>
          FORBIDDEN.test(line) ? [`${rel}:${i + 1}: ${line.trim()}`] : [],
        );
    });
}

describe("rm29 raw-key grep gate (rm29-spec §3, Inv 27)", () => {
  it("scans real files (the gate is not vacuous)", () => {
    const scanned = SCANNED.flatMap(files).filter((f) => /\.(py|ts)$/.test(f));
    expect(scanned.length).toBeGreaterThan(5);
  });

  it("finds no key normalisation in PRP/RP/RL, the sample seeds or the test helpers", () => {
    expect(hits()).toEqual([]);
  });

  it("allow-listed files still exist (a stale entry would hide a moved file)", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(statSync(join(ROOT, rel)).isFile(), rel).toBe(true);
    }
  });
});
