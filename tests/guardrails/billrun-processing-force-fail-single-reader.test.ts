import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// bm36-spec §Design/§Implementation §4 + verification checklist — the
// `BILLRUN_PROCESSING_FORCE_FAIL` posture guard (mirrors the distribution
// flag's D20 posture). The flag is a deploy-time/test toggle whose exported
// accessor `billRunProcessingForceFail` is read by EXACTLY ONE live source:
// `services/billing/trigger-run.ts`, which threads it onto the processing
// trigger payload's `force_fail`. It is NEVER read by a UI component or a
// Server Action (there is no operator control for it), so a `components/` or
// `actions/` reference is a review-blocking defect. This static, DB-free gate
// locks that in.
const REPO_ROOT = path.resolve(__dirname, "../..");

const ACCESSOR = "billRunProcessingForceFail";
const SOLE_READER = "services/billing/trigger-run.ts";

// A real READ is an import of the accessor from `@/lib/config` — not a bare
// substring, which also matches doc comments (e.g. `engine-client.ts` names the
// accessor in a comment on `ProcessingTriggerPayload.force_fail`).
const IMPORT_RE = new RegExp(
  `import\\s*\\{[^}]*\\b${ACCESSOR}\\b[^}]*\\}\\s*from\\s*["']@/lib/config["']`,
);

// The two surfaces that must NEVER read the flag (UI + operator actions).
const FORBIDDEN_DIRS = ["actions", "components"];

function collectFiles(dir: string, extensions: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath, extensions));
    } else if (extensions.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("BILLRUN_PROCESSING_FORCE_FAIL single-reader posture (bm36)", () => {
  it("is read by trigger-run.ts (the sole reader)", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, SOLE_READER), "utf8");
    expect(IMPORT_RE.test(src)).toBe(true);
  });

  it("is never read by a UI component or a Server Action", () => {
    const offenders: string[] = [];
    for (const dir of FORBIDDEN_DIRS) {
      for (const file of collectFiles(
        path.join(REPO_ROOT, dir),
        /\.(ts|tsx)$/,
      )) {
        if (IMPORT_RE.test(fs.readFileSync(file, "utf8"))) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is the only billing service that reads it", () => {
    const readers = collectFiles(
      path.join(REPO_ROOT, "services", "billing"),
      /\.ts$/,
    )
      .filter((file) => IMPORT_RE.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join("/"));
    expect(readers).toEqual([SOLE_READER]);
  });
});
