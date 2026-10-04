import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

import { logger } from "@/lib/logger";

// One-shot CLI (npm run check:rating-rename-gate). Invoked by the CI test_scan
// stage (rm22-spec §4 / Implementation §4): the rename gate. The
// udr_subscriber_ref_id → udr_subscription_ref_id rename (rm15 DB column + rm19
// wfm runtime) must be COMPLETE — zero stale references in CODE across both the
// app repo and workflow-management/. A stale reference is a join/field against a
// column that no longer exists, i.e. an already-broken path. Documentation
// (*.md) legitimately describes the rename, so it is excluded; this gate is
// about code, not prose. Never imported by application code.

const STALE = /udr_subscriber_ref_id|udrSubscriberRefId/;

// Code roots to scan — both the app repo's code dirs and the workflow-management
// subtree. Deliberately NOT the repo root (avoids node_modules, .next, build
// output, throwaway venvs, and the *.md context docs that describe the rename).
const SCAN_ROOTS = [
  "db",
  "tests",
  "validation",
  "services",
  "scripts",
  "app",
  "actions",
  "components",
  "lib",
  "hooks",
  "types",
  "workflow-management",
];
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".py",
  ".sql",
  ".yaml",
  ".yml",
]);
// Never descend into these (dependency trees, build output, throwaway venvs).
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "__pycache__",
]);

interface Violation {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // a root that does not exist in this checkout is simply skipped
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".venv")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (
      CODE_EXTENSIONS.has(extname(entry)) &&
      // The gate itself names the token (its regex + messages) — exclude it so
      // the detector does not flag its own source.
      entry !== "check-rating-rename-gate.ts"
    ) {
      out.push(full);
    }
  }
}

function main(): void {
  const root = process.cwd();
  const files: string[] = [];
  for (const r of SCAN_ROOTS) walk(join(root, r), files);

  const violations: Violation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (STALE.test(text)) {
        violations.push({ file, line: i + 1, text: text.trim() });
      }
    });
  }

  if (violations.length > 0) {
    logger.error(
      "rm22 rename gate FAILED — stale udr_subscriber_ref_id / udrSubscriberRefId reference(s) in code",
      { violations },
    );
    process.exit(1);
  }

  logger.info(
    "rm22 rename gate OK — zero stale udr_subscriber_ref_id / udrSubscriberRefId references in code",
    { scannedFileCount: files.length },
  );
}

main();
