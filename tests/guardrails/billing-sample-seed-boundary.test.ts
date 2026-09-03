import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// bm15-spec §Implementation §3 — "A CI/grep guard asserting db:seed-sample
// never appears in the db:setup chain (so a future edit can't silently wire
// sample data into the mandatory path)." Static, DB-free: reads
// package.json's own script bodies, no jsdom, no DB.
const REPO_ROOT = path.resolve(__dirname, "../..");

interface PackageJson {
  scripts: Record<string, string>;
}

function readPackageJson(): PackageJson {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  return JSON.parse(raw) as PackageJson;
}

const SAMPLE_SEED_INVOCATION = /\bdb:seed-sample\b/;

describe("grep gate — db:seed-sample is opt-in only, never part of the mandatory db:setup chain (bm15-spec D32)", () => {
  it("package.json declares a db:seed-sample script pointing at the sample seed", () => {
    const { scripts } = readPackageJson();
    expect(scripts["db:seed-sample"]).toBeDefined();
    expect(scripts["db:seed-sample"]).toContain(
      "db/seeds/sample/seed-billrun-sample.ts",
    );
  });

  it("db:setup's script body never invokes db:seed-sample", () => {
    const { scripts } = readPackageJson();
    expect(scripts["db:setup"]).toBeDefined();
    expect(scripts["db:setup"]).not.toMatch(SAMPLE_SEED_INVOCATION);
  });

  it("no other npm script wires db:seed-sample into a mandatory chain", () => {
    const { scripts } = readPackageJson();
    const offenders = Object.entries(scripts)
      .filter(([name]) => name !== "db:seed-sample")
      .filter(([, body]) => SAMPLE_SEED_INVOCATION.test(body))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
