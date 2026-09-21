import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/tests/helpers/strip-code-comments";

import {
  STATUS_LITERAL_ALLOWLIST,
  type StatusLiteralAllowEntry,
} from "./status-literal-allowlist";

// pm45-spec I3 — guardrail 30 (code-standards §9 / plan V5). G2's pre-flight
// grep, made permanent: a committed test that walks production source, collects
// every bare `'RETIRED'` / `'OBSOLETE'` string literal outside the two files
// where the union is DEFINED (`db/schema/product.ts`, `types/product.ts`), and
// asserts the set is exactly the justified allow-list beside it
// (status-literal-allowlist.ts). A new comparison added later fails CI until it
// carries a reason. Findings under `workflow-management/**` — read-only from
// this repo — are reported as a warning list, never asserted (D3).
//
// This proves the ABSENCE of an out-of-home literal that would treat a pinned
// version as unbillable/unreadable; it does not prove OBSOLETE bills (that is
// product-withdrawal-path.integration.test.ts + ship-gate guardrail 16 — the
// bill run resolves by pinned id, never by lifecycle_status, Inv. #17).
const REPO_ROOT = path.resolve(__dirname, "../..");

// Production source only — tests live under tests/** and legitimately carry
// these literals in fixtures; the sweep is about code paths, not test data.
const SCAN_ROOTS = [
  "actions",
  "app",
  "components",
  "db",
  "lib",
  "services",
  "scripts",
  "types",
  "validation",
  "auth",
];

// The union's two definition sites — the ONE place each literal is allowed to
// originate. Everything else is a comparison/write that the allow-list governs.
const DEFINITION_FILES = new Set([
  path.join(REPO_ROOT, "db", "schema", "product.ts").replace(/\\/g, "/"),
  path.join(REPO_ROOT, "types", "product.ts").replace(/\\/g, "/"),
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "target",
  "coverage",
]);

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectSourceFiles(path.join(dir, entry.name)));
    } else if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)
    ) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const LITERAL_RE = /['"`](RETIRED|OBSOLETE)['"`]/g;

function relPosix(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).replace(/\\/g, "/");
}

type Finding = { file: string; literal: "RETIRED" | "OBSOLETE" };

function sweepProductionSource(): Finding[] {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of collectSourceFiles(path.join(REPO_ROOT, root))) {
      if (DEFINITION_FILES.has(abs.replace(/\\/g, "/"))) continue;
      const code = stripComments(fs.readFileSync(abs, "utf8"));
      for (const m of code.matchAll(LITERAL_RE)) {
        const literal = m[1] as "RETIRED" | "OBSOLETE";
        const key = `${relPosix(abs)}::${literal}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ file: relPosix(abs), literal });
      }
    }
  }
  return findings;
}

function keyOf(e: { file: string; literal: string }): string {
  return `${e.file}::${e.literal}`;
}

describe("guardrail 30 — status-literal sweep (pm45 I3)", () => {
  const findings = sweepProductionSource();
  const allowKeys = new Set(STATUS_LITERAL_ALLOWLIST.map(keyOf));
  const foundKeys = new Set(findings.map(keyOf));

  // 1. No unexpected literal: every `'RETIRED'`/`'OBSOLETE'` comparison in
  //    production source outside the two definition files is on the allow-list.
  //    A newly-introduced one fails here until it is justified with an entry.
  it("every status literal in production source is on the allow-list", () => {
    const unexpected = findings
      .filter((f) => !allowKeys.has(keyOf(f)))
      .map((f) => `${f.file} → '${f.literal}'`);
    expect(unexpected).toEqual([]);
  });

  // 2. No stale allow-list entry: an entry whose literal no longer exists in its
  //    file is drift and must be removed (keeps every reason honest — D3).
  it("every allow-list entry still corresponds to a real occurrence", () => {
    const stale = STATUS_LITERAL_ALLOWLIST.filter(
      (e) => !foundKeys.has(keyOf(e)),
    ).map((e: StatusLiteralAllowEntry) => `${e.file} → '${e.literal}'`);
    expect(stale).toEqual([]);
  });

  // 3. Every allow-list entry carries a non-empty reason (D3: "a one-line reason
  //    each").
  it("every allow-list entry carries a reason", () => {
    const reasonless = STATUS_LITERAL_ALLOWLIST.filter(
      (e) => e.reason.trim().length === 0,
    ).map((e) => keyOf(e));
    expect(reasonless).toEqual([]);
  });

  // 4. workflow-management/** is READ-ONLY from this repo (code-standards §6.5 /
  //    workflow-rules §6.5): the sweep REPORTS what it finds there as a warning
  //    carried to the pm45 hand-off register, and never asserts on it. The pm35
  //    G2 sweep recorded zero offering-lifecycle_status references there (billing
  //    resolves pinned versions, Inv. #17), so this list is expected empty; if a
  //    future flow adds a RETIRED/OBSOLETE reference, it surfaces here as a
  //    warning to triage, not a CI failure.
  it("reports (never asserts) any workflow-management/** status references", () => {
    // Scan ONLY the committed flow source, enumerated via `git ls-files` — never
    // the git-ignored runtime output under `dev/logs`, `dev/landing`, `dev/error`,
    // `dev/archive`, `dev/distribution` (the engine writes thousands of `.jsonl`
    // records there at runtime). Those are not flow source, and walking them made
    // a warn-only scan traverse the whole log volume and time the suite out on any
    // dev box that had run the engine. `git ls-files` returns forward-slash,
    // repo-relative, tracked paths only — inherently excluding the ignored dirs.
    const TEXT_EXT = /\.(sql|ya?ml|ts|tsx|js|mjs|cjs|json|jsonl|md|txt)$/;
    let tracked: string[] = [];
    try {
      tracked = execFileSync("git", ["ls-files", "workflow-management"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      })
        .split("\n")
        .filter(Boolean);
    } catch {
      // No git / not a work-tree → nothing to report. The scan is advisory only,
      // so an empty result is a safe (and correct) outcome, never a failure.
      tracked = [];
    }

    const hits: string[] = [];
    for (const rel of tracked) {
      if (!TEXT_EXT.test(rel)) continue;
      const abs = path.join(REPO_ROOT, rel);
      let size: number;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue; // tracked-but-absent (e.g. sparse checkout)
      }
      if (size > 256 * 1024) continue;
      fs.readFileSync(abs, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/\b(RETIRED|OBSOLETE)\b/.test(line)) {
            hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
          }
        });
    }

    if (hits.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[guardrail 30] workflow-management/** RETIRED/OBSOLETE references (warn-only, carried to the pm45 hand-off register):\n${hits.join("\n")}`,
      );
    }
    // Advisory scan: assert only that it RAN and produced a (possibly empty)
    // list — NEVER on the contents. workflow-management/** is out of this repo's
    // write boundary (D3), so a finding there is triage, not a CI failure.
    expect(Array.isArray(hits)).toBe(true);
  });
});
