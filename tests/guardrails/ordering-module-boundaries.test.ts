import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// pm26-spec §4 verification: `services/ordering/*` is framework-agnostic (no
// `next/*` import — general §3.14) and holds no raw SQL (SQL lives only under
// `db/**` — services call repositories only). Pure node:fs static-source scan,
// no DB (mirrors customer-module-boundaries' approach).
const REPO_ROOT = path.resolve(__dirname, "../..");

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(entryPath);
    return /\.ts$/.test(entry.name) ? [entryPath] : [];
  });
}

function servicesOrderingFiles(): { relative: string; content: string }[] {
  return collectFiles(path.join(REPO_ROOT, "services", "ordering")).map(
    (filePath) => ({
      relative: path.relative(REPO_ROOT, filePath).split(path.sep).join("/"),
      content: fs.readFileSync(filePath, "utf8"),
    }),
  );
}

describe("ordering module boundaries (pm26 §4)", () => {
  it("has service files under services/ordering", () => {
    expect(servicesOrderingFiles().length).toBeGreaterThan(0);
  });

  it("no services/ordering file imports from next/*", () => {
    const offenders = servicesOrderingFiles()
      .filter(({ content }) => /from\s+["']next(\/|["'])/.test(content))
      .map(({ relative }) => relative);
    expect(offenders).toEqual([]);
  });

  it("no services/ordering file contains raw SQL (SQL lives only in db/**)", () => {
    const offenders = servicesOrderingFiles()
      .filter(
        ({ content }) =>
          /\bsql`/.test(content) || /from\s+["']drizzle-orm["']/.test(content),
      )
      .map(({ relative }) => relative);
    expect(offenders).toEqual([]);
  });
});
