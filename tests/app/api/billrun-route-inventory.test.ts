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

  it("declares only POST — no GET or other verb — on either handler", () => {
    for (const relativePath of EXPECTED_HANDLERS) {
      const content = fs.readFileSync(
        path.join(BILLRUN_API_DIR, relativePath),
        "utf8",
      );
      expect(content).toMatch(/export async function POST\(/);
      for (const verb of ["GET", "PUT", "PATCH", "DELETE"]) {
        expect(content).not.toMatch(
          new RegExp(`export (async )?function ${verb}\\(`),
        );
      }
    }
  });
});
