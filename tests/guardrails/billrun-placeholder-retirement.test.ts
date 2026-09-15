import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// bm33-spec §4 — the retirement grep gate. `BILLRUN_PLACEHOLDER_MODE` and the
// `PlaceholderBanner`/`PlaceholderBadge` surface are RETIRED (D31; architecture
// Inv #15 is a retired tombstone). Once the real processing flow (bm30) is
// complete the banner's copy ("the billing steps are placeholders") is false,
// so the flag, the accessor, the components and every call site are deleted.
// This static, DB-free gate locks that in: no live source reference to any of
// the five retired identifiers may reappear. Comment prose is stripped before
// matching (a doc-style comment naming the retired flag by name — as the
// heavily-annotated seed guardrails do — is not a call site), and the context
// docs (`billmgmt-*`, historical `bmNN` specs, this tracker) are out of scope
// by construction: only the real source tree is scanned.
const REPO_ROOT = path.resolve(__dirname, "../..");

// Every TS/TSX source root that could hold a live reference — the app, its
// actions, auth, components, config/lib, the ops scripts, services, the shared
// types (the deleted `placeholderMode` prop rode on billing types), and the
// test suite (a test threading the deleted prop would be a real call site too).
// Docs (`context/**`, README) and node_modules are deliberately never scanned —
// the retired names legitimately survive in historical prose there.
const SCAN_DIRS = [
  "actions",
  "app",
  "auth",
  "components",
  "db",
  "lib",
  "scripts",
  "services",
  "tests",
  "types",
  "validation",
];

// The five retired identifiers (spec §4). Word-bounded so an unrelated
// substring can't trip the gate.
const RETIRED_PATTERN =
  /\b(BILLRUN_PLACEHOLDER_MODE|isBillrunPlaceholderMode|placeholderMode|PlaceholderBanner|PlaceholderBadge)\b/;

// This gate file itself names all five identifiers (in the pattern above and
// in its assertions), so it is excluded from the scan — it is the enforcer,
// not a call site.
const SELF = "tests/guardrails/billrun-placeholder-retirement.test.ts";

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

// Strips `//` line comments before matching, so a comment that names a retired
// identifier in prose (as the smoke script and seed-marker guardrail
// deliberately do) isn't mistaken for a live reference. String/template state
// is carried ACROSS lines (mode/stringChar/interpDepth persist between
// iterations), so a `//` inside a quoted string OR on a continuation line of a
// multiline template literal — e.g. a `://` in an embedded URL — is preserved,
// not mistaken for a comment start. This is the cross-line stripper the
// accounts grep gates (tests/accounts/grep-gates.test.ts) established and
// regression-tested; a naive per-line reset would reintroduce that false
// negative. Line comments only (no `/* */` stripping) — like the precedent, no
// scanned source uses block comments for this kind of prose.
function stripLineComments(content: string): string {
  let mode: "code" | "string" | "template" = "code";
  let stringChar = ""; // closing delimiter while mode === "string"
  let interpDepth = 0; // ${...} nesting inside a template literal

  const lines = content.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    let cutAt = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      const next = line[i + 1];

      if (mode === "string") {
        if (ch === "\\") {
          i++;
        } else if (ch === stringChar) {
          mode = "code";
          stringChar = "";
        }
      } else if (mode === "template") {
        if (ch === "\\") {
          i++;
        } else if (ch === "`") {
          mode = "code";
        } else if (ch === "$" && next === "{") {
          mode = "code";
          interpDepth = 1;
          i++; // consume "{"
        }
      } else {
        // code mode — outside any string, or inside a ${...} interpolation
        if (ch === "\\") {
          i++;
        } else if (interpDepth > 0 && ch === "{") {
          interpDepth++;
        } else if (interpDepth > 0 && ch === "}") {
          if (--interpDepth === 0) mode = "template";
        } else if (ch === '"' || ch === "'") {
          mode = "string";
          stringChar = ch;
        } else if (ch === "`") {
          mode = "template";
        } else if (ch === "/" && next === "/") {
          cutAt = i;
          break;
        }
      }
    }
    result.push(cutAt >= 0 ? line.slice(0, cutAt) : line);
  }

  return result.join("\n");
}

const SOURCE_FILES = SCAN_DIRS.flatMap((dir) =>
  collectFiles(path.join(REPO_ROOT, dir), /\.(ts|tsx)$/),
)
  .map((filePath) => ({
    relative: path.relative(REPO_ROOT, filePath).split(path.sep).join("/"),
    content: fs.readFileSync(filePath, "utf8"),
  }))
  .filter(({ relative }) => relative !== SELF);

describe("grep gate — BILLRUN_PLACEHOLDER_MODE / PlaceholderBanner retirement (bm33-spec §4, D31)", () => {
  it("scanned a non-trivial slice of the source tree (the gate isn't vacuously passing)", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
  });

  it("every scan root actually contributed files (a silent per-root collapse can't hide a live reference)", () => {
    // The aggregate count above is dominated by `tests/`, so it would stay
    // green even if a code root (a rename, a path/casing bug, a collectFiles
    // regression) silently collected zero files — the exact surface a retired
    // identifier is most likely to reappear on. Assert each root non-empty.
    const emptyRoots = SCAN_DIRS.filter(
      (dir) =>
        !SOURCE_FILES.some(
          (f) => f.relative === dir || f.relative.startsWith(`${dir}/`),
        ),
    );
    expect(emptyRoots).toEqual([]);
  });

  it("no live source file references any retired placeholder identifier", () => {
    const offenders = SOURCE_FILES.filter(({ content }) =>
      RETIRED_PATTERN.test(stripLineComments(content)),
    ).map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });

  it("the placeholder-banner component file is deleted", () => {
    expect(
      fs.existsSync(
        path.join(REPO_ROOT, "components/billing/placeholder-banner.tsx"),
      ),
    ).toBe(false);
  });

  it("lib/config.ts no longer defines the flag or its accessor", () => {
    const src = stripLineComments(
      fs.readFileSync(path.join(REPO_ROOT, "lib/config.ts"), "utf8"),
    );
    expect(src).not.toContain("BILLRUN_PLACEHOLDER_MODE");
    expect(src).not.toContain("isBillrunPlaceholderMode");
    // The distribution force-fail flag STAYS — bm34 uses it to force a
    // mandatory-target failure (spec §Design).
    expect(src).toContain("BILLRUN_DISTRIBUTION_FORCE_FAIL");
  });
});
