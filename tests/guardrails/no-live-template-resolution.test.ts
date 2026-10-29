import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/tests/helpers/strip-code-comments";

// Guardrail item 57 (bm67-spec §5; billing Inv #53, D33) — no live template
// resolution on a run path. After bm67 posting copies the BAN's run stamps,
// the draft renders them (`run` mode), and the only live resolutions are
// run-start capture and the Invoice Settings editor's `preview-family`.
// Static-source assertions over production code (comment-stripped, so a
// historical mention in a doc comment is not a call), in the cm22 file's
// style: no DB, no jsdom.
const REPO_ROOT = path.resolve(__dirname, "../..");
const SKIPPED_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__"]);

function collect(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...collect(rel));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

function code(relative: string): string {
  return stripComments(fs.readFileSync(path.join(REPO_ROOT, relative), "utf8"));
}

// The run paths: posting, the binder entry point and the draft PRO-FORMA
// route (bm88 retired the CSV output).
const RUN_PATH_FILES = [
  "services/billing/post-run.ts",
  "services/billing/render-invoice-template.ts",
  "app/(app)/billing/bill-runs/[runId]/draft-invoice/[banId]/route.ts",
];

// The only two callers of the live family resolver (bm65 capture, bm66
// preview).
const LIVE_RESOLVER_IMPORTERS = [
  "services/billing/capture-template-stamps.ts",
  "services/billing/invoice-template/preview.ts",
];
const RESOLVER_FILE = "services/billing/invoice-template/resolve-template.ts";

// The live resolver exports (review fix: the family resolver was split into
// its generated and shared halves so capture reads CSV/profile once).
const LIVE_RESOLVERS =
  /\b(?:resolveCurrentVersionsForFamily|resolveGeneratedForFamily|resolveSharedCurrentVersions)\b/;

describe("guardrail 57 — no live template resolution on a run path", () => {
  const productionFiles = ["services", "db", "app"].flatMap(collect);

  it("scans a real production tree (not vacuous)", () => {
    expect(productionFiles.length).toBeGreaterThan(100);
    for (const file of [...RUN_PATH_FILES, ...LIVE_RESOLVER_IMPORTERS]) {
      expect(productionFiles, file).toContain(file);
    }
  });

  it("resolveVersionsForPosting exists nowhere under services/, db/ or app/", () => {
    const offenders = productionFiles.filter((f) =>
      /\bresolveVersionsForPosting\b/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("no run-path file builds a preview-family mode or imports a live resolver", () => {
    for (const file of RUN_PATH_FILES) {
      const source = code(file);
      expect(source, file).not.toMatch(/["']preview-family["']/);
      expect(source, file).not.toMatch(LIVE_RESOLVERS);
    }
  });

  // `preview.ts` reaches the live resolver through `resolveTemplate`'s
  // `preview-family` case rather than importing it, so the check is "no file
  // outside these two imports it", with capture as the one direct importer.
  it("only capture-template-stamps.ts and preview.ts may import a live resolver", () => {
    const importers = productionFiles
      .filter((f) => f !== RESOLVER_FILE)
      .filter((f) => LIVE_RESOLVERS.test(code(f)));
    for (const importer of importers) {
      expect(LIVE_RESOLVER_IMPORTERS, importer).toContain(importer);
    }
    expect(importers).toContain("services/billing/capture-template-stamps.ts");
  });

  it("the preview-family mode is built only by the editor preview", () => {
    const builders = productionFiles
      .filter((f) => f !== RESOLVER_FILE && !f.startsWith("db/"))
      .filter((f) => /kind:\s*["']preview-family["']/.test(code(f)));
    expect(builders).toEqual(["services/billing/invoice-template/preview.ts"]);
  });
});
