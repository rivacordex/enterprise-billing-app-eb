import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// bm13-spec §5/§Verification checklist — billmgmt-code-standards.md §5.1:
// "Exactly two handlers exist, both under app/api/billrun/ ... No GET, no
// other verbs, no other paths. Adding a third handler needs an architecture
// decision." `tests/app/route-manifest.test.ts` enumerates `app/**/page.tsx`
// only (a Route Handler is not a page), so this is the M2M surface's own
// inventory lock — the two-page test's counterpart for the module's other
// mutation surface (code-standards §8's permission-map table row count).
const REPO_ROOT = path.resolve(__dirname, "../../..");
const BILLRUN_API_DIR = path.join(REPO_ROOT, "app", "api", "billrun");

const EXPECTED_HANDLERS = [
  "[runId]/stage/[stage]/complete/route.ts",
  "[runId]/status/route.ts",
] as const;

function collectRouteFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectRouteFiles(entryPath));
    } else if (entry.isFile() && entry.name === "route.ts") {
      files.push(
        path.relative(BILLRUN_API_DIR, entryPath).split(path.sep).join("/"),
      );
    }
  }

  return files;
}

describe("app/api/billrun/** route inventory (bm13 ship gate)", () => {
  it("has exactly the two documented M2M Route Handlers, no more, no fewer", () => {
    const found = collectRouteFiles(BILLRUN_API_DIR).sort();
    expect(found).toEqual([...EXPECTED_HANDLERS].sort());
  });

  // Every HTTP-method export Next.js recognises as a Route Handler, in ANY
  // export syntax — a declaration (`export function GET`), a const/let/var
  // (`export const GET = ...`), or a named/aliased re-export (`export { GET }`,
  // `export { handler as GET }`). Only POST may appear (as an async function);
  // adding any other verb needs an architecture decision (code-standards §5.1).
  const FORBIDDEN_VERBS = [
    "GET",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ] as const;

  it("declares only POST — no other verb, in any export syntax — on either handler", () => {
    for (const relativePath of EXPECTED_HANDLERS) {
      const content = fs.readFileSync(
        path.join(BILLRUN_API_DIR, relativePath),
        "utf8",
      );
      expect(content).toMatch(/export async function POST\(/);

      // Named/aliased re-exports: what registers a handler is the EXPORTED name,
      // i.e. the alias TARGET — `export { handler as GET }` registers GET (reject),
      // but `export { GET as helper }` (or `GET as POST`) re-exports a local GET
      // under a different name and registers no GET handler (allow). Collect each
      // clause's exported name: the identifier after `as`, else the bare one.
      const reexportedNames = new Set<string>();
      for (const block of content.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const clause of block[1]!.split(",")) {
          const trimmed = clause.trim();
          if (!trimmed) continue;
          const aliased = trimmed.match(/\bas\s+([A-Za-z_$][\w$]*)/);
          const exportedName = aliased ? aliased[1] : trimmed.split(/\s+/)[0];
          if (exportedName) reexportedNames.add(exportedName);
        }
      }

      for (const verb of FORBIDDEN_VERBS) {
        // Declaration: `export function GET` / `export async function GET`.
        expect(content).not.toMatch(
          new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`),
        );
        // Binding: `export const GET =` / `export let GET` / `export var GET`.
        expect(content).not.toMatch(
          new RegExp(`export\\s+(?:const|let|var)\\s+${verb}\\b`),
        );
        // Named/aliased re-export: matched on the exported (alias-target) name.
        expect(reexportedNames.has(verb)).toBe(false);
      }
    }
  });
});
