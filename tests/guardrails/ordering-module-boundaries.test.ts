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
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
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

// pm29-spec §Implementation-1 / Verification checklist — the ordering
// module's first Server Action folder, pm19's incremental-allow-list
// precedent (`PRODUCT_ACTION_FILES`, product-module-boundaries.test.ts).
// Pinned to exactly this one file: read-only wizard support lives in
// actions/accounts/new-order-wizard-reads.ts instead (components/** may not
// depend on services/**/auth/** directly, and actions/customer/,
// actions/product/ are each pinned by their own existing allow-list) —
// deliberately outside this allow-list's scope.
const EXPECTED_ORDERING_ACTION_FILES: Record<string, string> = {
  "create-order.action.ts": "createOrderAction",
};

describe("ordering module boundaries (pm26 §4)", () => {
  it("has service files under services/ordering", () => {
    expect(servicesOrderingFiles().length).toBeGreaterThan(0);
  });

  it("no services/ordering file imports from next/* (static, side-effect, or dynamic)", () => {
    // Catches `from "next/..."`, bare side-effect `import "next/..."`, and
    // dynamic `import("next/...")` (and the bare `"next"` package) alike.
    const NEXT_IMPORT = /(?:from|import)\s*\(?\s*["']next(?:\/|["'])/;
    const offenders = servicesOrderingFiles()
      .filter(({ content }) => NEXT_IMPORT.test(content))
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

  it("actions/ordering/ exists and exports exactly this phase's action set", () => {
    const actionsDir = path.join(REPO_ROOT, "actions", "ordering");
    expect(fs.existsSync(actionsDir)).toBe(true);

    const actualFiles = fs
      .readdirSync(actionsDir)
      .filter((name) => name.endsWith(".action.ts"))
      .sort();
    expect(actualFiles).toEqual(
      Object.keys(EXPECTED_ORDERING_ACTION_FILES).sort(),
    );

    for (const [fileName, exportName] of Object.entries(
      EXPECTED_ORDERING_ACTION_FILES,
    )) {
      const source = fs.readFileSync(path.join(actionsDir, fileName), "utf8");
      const exportedFunctionNames = [
        ...source.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g),
      ].map((m) => m[1]);
      expect(exportedFunctionNames).toEqual([exportName]);
    }
  });
});
