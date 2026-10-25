import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { listSourceFiles } from "@/tests/helpers/list-source-files";

// bm75-spec §2 / billmgmt-code-standards.md guardrail item 74 (draft/final
// half), Inv #64 — every Chromium render in the app goes through the ONE
// hardened context factory, `withHardenedPage` in
// `services/billing/render-invoice.ts`: JavaScript off, offline, and every
// request except data:/about: routed to an abort. A DB-free static-source
// scan: no other production file may launch Chromium or open a context/page.

const ROOT = process.cwd();

const SOURCE_DIRS = ["app", "actions", "services", "lib", "db", "scripts"];

const FACTORY_FILE = "services/billing/render-invoice.ts";

// Any engine (chromium, firefox, webkit), by property or bracket access, any
// launch* or connect* entry point (launchPersistentContext, connectOverCDP …),
// and any context or page creation (code review fix 2026-10-25: the first
// pattern missed all but `chromium.launch` and `browser.newPage(`).
const CHROMIUM_USE =
  /\b(?:chromium|firefox|webkit)\s*(?:\.|\[\s*["'`])\s*(?:launch|connect)\w*|\.newContext\s*\(|\.newPage\s*\(/;

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
