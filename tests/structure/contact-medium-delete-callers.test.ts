import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// cm13-spec §3.3 / code-standards §6.7 — `contactMediumRepository.deleteById`
// has no built-in guard of its own; `deleteContact`
// (`services/customer/contact-mutations.ts`) is the only caller allowed to
// invoke it. Enforced here by a grep-based structural check, since the type
// system can't express "only this one function may call this." Same
// node:fs/node:path scan shape as `tests/guardrails/product-module-boundaries.test.ts`.
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["actions", "app", "components", "db", "services"];
const OWN_DEFINITION = "db/repositories/contact-medium.ts";
const SANCTIONED_CALLER = "services/customer/contact-mutations.ts";

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

describe("contactMediumRepository.deleteById callers (structural)", () => {
  it("is referenced from nowhere but its own definition and deleteContact", () => {
    const files = SCAN_DIRS.flatMap((dir) =>
      collectFiles(path.join(REPO_ROOT, dir)),
    );
    expect(files.length).toBeGreaterThan(0);

    const offenders = files
      .map((filePath) => ({
        relative: path.relative(REPO_ROOT, filePath).split(path.sep).join("/"),
        content: fs.readFileSync(filePath, "utf8"),
      }))
      .filter(({ relative }) => relative !== OWN_DEFINITION)
      .filter(({ relative }) => relative !== SANCTIONED_CALLER)
      .filter(({ content }) =>
        content.includes("contactMediumRepository.deleteById"),
      )
      .map(({ relative }) => relative);

    expect(offenders).toEqual([]);
  });
});
