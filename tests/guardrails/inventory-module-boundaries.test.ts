import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// pm32-spec verification checklist — `services/inventory/*` is
// framework-agnostic (no `next/*` import — general §3.14) and holds no raw
// SQL (SQL lives only under `db/**` — services call repositories only).
// Pure node:fs static-source scan, no DB (ordering-module-boundaries
// precedent).
const REPO_ROOT = path.resolve(__dirname, "../..");

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function servicesInventoryFiles(): { relative: string; content: string }[] {
  return collectFiles(path.join(REPO_ROOT, "services", "inventory")).map(
    (filePath) => ({
      relative: path.relative(REPO_ROOT, filePath).split(path.sep).join("/"),
      content: fs.readFileSync(filePath, "utf8"),
    }),
  );
}

// pm33-spec §4 — the inventory module's first Server Action folder
// (ordering-module-boundaries' EXPECTED_ORDERING_ACTION_FILES precedent).
const EXPECTED_INVENTORY_ACTION_FILES: Record<string, string> = {
  "suspend-subscription.action.ts": "suspendSubscriptionAction",
  "resume-subscription.action.ts": "resumeSubscriptionAction",
  "terminate-subscription.action.ts": "terminateSubscriptionAction",
  "update-characteristics.action.ts": "updateCharacteristicsAction",
};

describe("inventory module boundaries (pm32-spec verification checklist)", () => {
  it("has service files under services/inventory", () => {
    expect(servicesInventoryFiles().length).toBeGreaterThan(0);
  });

  it("no services/inventory file imports from next/* (static, side-effect, or dynamic)", () => {
    const NEXT_IMPORT = /(?:from|import)\s*\(?\s*["']next(?:\/|["'])/;
    const offenders = servicesInventoryFiles()
      .filter(({ content }) => NEXT_IMPORT.test(content))
      .map(({ relative }) => relative);
    expect(offenders).toEqual([]);
  });

  it("no services/inventory file contains raw SQL (SQL lives only in db/**)", () => {
    const offenders = servicesInventoryFiles()
      .filter(
        ({ content }) =>
          /\bsql`/.test(content) || /from\s+["']drizzle-orm["']/.test(content),
      )
      .map(({ relative }) => relative);
    expect(offenders).toEqual([]);
  });

  it("actions/inventory/ exists and exports exactly this phase's action set", () => {
    const actionsDir = path.join(REPO_ROOT, "actions", "inventory");
    expect(fs.existsSync(actionsDir)).toBe(true);

    const actualFiles = fs
      .readdirSync(actionsDir)
      .filter((name) => name.endsWith(".action.ts"))
      .sort();
    expect(actualFiles).toEqual(
      Object.keys(EXPECTED_INVENTORY_ACTION_FILES).sort(),
    );

    for (const [fileName, exportName] of Object.entries(
      EXPECTED_INVENTORY_ACTION_FILES,
    )) {
      const source = fs.readFileSync(path.join(actionsDir, fileName), "utf8");
      const exportedFunctionNames = [
        ...source.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g),
      ].map((m) => m[1]);
      expect(exportedFunctionNames).toEqual([exportName]);
    }
  });
});
