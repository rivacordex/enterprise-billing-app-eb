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

// Raw-SQL detection. Drizzle's `sql` tagged template counts even with
// whitespace between the tag and the backtick (`sql `…`` is still a valid
// tagged template), so allow optional whitespace while retaining the compact
// `sql`…`` form. drizzle-orm imports (and its submodules) are the second signal.
const RAW_SQL_TAG = /\bsql\s*`/;
const DRIZZLE_IMPORT = /from\s+["']drizzle-orm(?:\/[^"']*)?["']/;

function hasRawSql(content: string): boolean {
  return RAW_SQL_TAG.test(content) || DRIZZLE_IMPORT.test(content);
}

// The single allowed runtime export per action file: one top-level
// `export async function <name>`. Generics are permitted between the name and
// the parameter list, so the matcher stops at the name rather than requiring
// `(` right after it (`export async function foo<T>(…)` must still be captured).
// An async *generator* (`function* …`) is intentionally NOT captured here — it
// has no whitespace after `function`, so it falls through to the disallowed set.
function runtimeExportedAsyncFunctionNames(source: string): string[] {
  return [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map(
    (m) => m[1]!,
  );
}

// Every other runtime export form is disallowed. Type-only `export type` /
// `export interface` (erased at build) are allowed; `export const/let/var`,
// non-async `export function`, `export class`, `export default`, `export { … }`
// re-exports, `export *`, and async generators (`export async function* …`) are
// not. Leading indentation is tolerated because a top-level export statement may
// still be indented in source (whitespace is insignificant), and column-0
// anchoring would otherwise let an indented export slip past.
const DISALLOWED_RUNTIME_EXPORT =
  /^[ \t]*export\s+(?!type\s|interface\s)(?:async\s+function\s*\*|default\b|const\b|let\b|var\b|class\b|function\b|\{|\*)/gm;

function disallowedRuntimeExports(source: string): string[] {
  return [...source.matchAll(DISALLOWED_RUNTIME_EXPORT)].map((m) =>
    m[0].trim(),
  );
}

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
      .filter(({ content }) => hasRawSql(content))
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
      expect(runtimeExportedAsyncFunctionNames(source)).toEqual([exportName]);

      // …and nothing else runtime-exported: an action file's only runtime
      // export must be that one async function (see DISALLOWED_RUNTIME_EXPORT).
      expect(disallowedRuntimeExports(source)).toEqual([]);
    }
  });
});

describe("inventory boundary matchers (regression fixtures)", () => {
  it("flags a `sql` tagged template whether or not whitespace precedes the backtick", () => {
    expect(hasRawSql("const q = sql`select 1`;")).toBe(true);
    expect(hasRawSql("const q = sql `select 1`;")).toBe(true);
    expect(hasRawSql("const q = sql\n  `select 1`;")).toBe(true);
    // Bare identifier + unrelated template must not trip the guard.
    expect(hasRawSql("const sql = 1;\nconst s = `hi`;")).toBe(false);
  });

  it("captures a generic `export async function` action name", () => {
    expect(
      runtimeExportedAsyncFunctionNames(
        "export async function fooAction<T>(input: T) {}",
      ),
    ).toEqual(["fooAction"]);
  });

  it("flags an async-generator export as disallowed", () => {
    const src = "export async function* leaky() { yield 1; }";
    // Not counted as the one allowed async function…
    expect(runtimeExportedAsyncFunctionNames(src)).toEqual([]);
    // …and explicitly rejected.
    expect(disallowedRuntimeExports(src)).toEqual(["export async function*"]);
  });

  it("flags a disallowed export even with leading indentation", () => {
    expect(disallowedRuntimeExports("  export const sneaky = 1;")).toEqual([
      "export const",
    ]);
  });

  it("still allows a plain async function and type-only exports", () => {
    const src = [
      "export type Result = { ok: true };",
      "export interface Opts { id: string }",
      "export async function okAction(input: unknown) {}",
    ].join("\n");
    expect(runtimeExportedAsyncFunctionNames(src)).toEqual(["okAction"]);
    expect(disallowedRuntimeExports(src)).toEqual([]);
  });
});
