import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

// bm75-spec §2 / billmgmt-code-standards.md guardrail item 74 (draft/final
// half), Inv #64 — every Chromium render in the app goes through the ONE
// hardened context factory, `withHardenedPage` in
// `services/billing/render-invoice.ts`: JavaScript off, offline, and every
// request except data:/about: routed to an abort. A DB-free static-source
// scan: no other production file may launch Chromium or open a context/page.

const ROOT = process.cwd();

const SOURCE_DIRS = ["app", "actions", "services", "lib", "db", "scripts"];

const FACTORY_FILE = "services/billing/render-invoice.ts";

const CHROMIUM_USE = /\bchromium\.launch\b|\.newContext\(|\bbrowser\.newPage\(/;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      if (entry === "node_modules") continue;
      const child = resolve(abs, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(relative(ROOT, child).split(sep).join("/"));
      }
    }
  };
  const abs = resolve(ROOT, dir);
  if (existsSync(abs)) walk(abs);
  return out;
}

describe("guardrail 74 — one hardened Chromium factory (Inv #64)", () => {
  it("only services/billing/render-invoice.ts launches Chromium or opens a context/page", () => {
    const matching = SOURCE_DIRS.flatMap(listSourceFiles)
      .filter((file) => CHROMIUM_USE.test(readFileSync(file, "utf8")))
      .sort();

    expect(matching).toEqual([FACTORY_FILE]);
  });

  it("the factory's context is script-free, offline and routes every request", () => {
    const src = readFileSync(resolve(ROOT, FACTORY_FILE), "utf8");

    expect(src).toContain("javaScriptEnabled: false");
    expect(src).toContain("offline: true");
    expect(src).toContain('page.route("**/*"');
  });
});
