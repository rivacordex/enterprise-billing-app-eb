import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Seed-refactor change (D2) — demo data is a dedicated, opt-in, prod-guarded
// `db:seed-demo`; it is NEVER in `db:setup`. This static grep gate enforces that
// invariant so a future edit can't silently wire demo data into the mandatory
// path (the sibling `db:seed-sample` guard, billing-sample-seed-boundary.test.ts,
// does the same for the sample seed). DB-free: reads package.json's own script
// bodies, no jsdom, no DB.
const REPO_ROOT = path.resolve(__dirname, "../..");

interface PackageJson {
  scripts: Record<string, string>;
}

function readPackageJson(): PackageJson {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  return JSON.parse(raw) as PackageJson;
}

// Matches BOTH the npm-script alias (`db:seed-demo`) and a direct file-path
// invocation (`node ... db/seeds/demo/seed-demo.ts`) — a mandatory chain could
// wire the demo seed in either form, so the boundary gate must catch both.
const DEMO_SEED_INVOCATION = /\bdb:seed-demo\b|db\/seeds\/demo\/seed-demo\.ts/;

describe("grep gate — db:seed-demo is opt-in only, never part of the mandatory db:setup chain (seed-refactor D2)", () => {
  it("package.json declares a db:seed-demo script pointing at the demo seed orchestrator", () => {
    const { scripts } = readPackageJson();
    expect(scripts["db:seed-demo"]).toBeDefined();
    expect(scripts["db:seed-demo"]).toContain("db/seeds/demo/seed-demo.ts");
  });

  it("db:setup's script body never invokes db:seed-demo", () => {
    const { scripts } = readPackageJson();
    expect(scripts["db:setup"]).toBeDefined();
    expect(scripts["db:setup"]).not.toMatch(DEMO_SEED_INVOCATION);
  });

  it("no other npm script wires db:seed-demo into a mandatory chain", () => {
    const { scripts } = readPackageJson();
    const offenders = Object.entries(scripts)
      .filter(([name]) => name !== "db:seed-demo")
      .filter(([, body]) => DEMO_SEED_INVOCATION.test(body))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
