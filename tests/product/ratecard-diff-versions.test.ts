import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/tests/helpers/strip-code-comments";

// pm62-spec I2.10/I2.11 — the two assertions that need no database at all:
// (10) the diff's row key is built from the SAME shared delimiter/function
// pm58's duplicate-key check uses (not a second literal), and (11) the module
// opens no transaction, writes nothing and contains no effectivity window
// (D7). Static source checks, matching this repo's guardrail-test convention
// (e.g. tests/guardrails/product-module-boundaries.test.ts) — the behavioural
// proof that colliding tuples never merge, and the full bucket matrix
// (I2.1–I2.9), are the live-DB suite's
// (tests/db/ratecard-diff-versions.integration.test.ts), because the service
// itself does two real reads and has no DB-free seam to inject fixture rows
// through.
const SOURCE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "services",
  "product",
  "ratecard",
  "diff-versions.ts",
);
const source = fs.readFileSync(SOURCE_PATH, "utf8");
// Comments (this file's own doc-block explains D7's "no effectivity, no
// as-of window" rule in prose) are stripped first, so the assertions below
// react to real code, never to a comment that merely NAMES the forbidden
// thing (tests/helpers/strip-code-comments.ts, the guardrail-13 pattern).
const code = stripComments(source);

describe("diff-versions.ts (static, DB-free)", () => {
  it("imports the shared row-key function from pm58's validation file, rather than re-declaring a delimiter literal (D4, I2.10)", () => {
    expect(code).toMatch(
      /import\s*\{\s*rateCardRowKey\s*\}\s*from\s*"@\/validation\/product\/ratecard\.schema"/,
    );
    // No second delimiter literal anywhere in the CODE — the NUL byte is
    // spelled once, in validation/product/ratecard.schema.ts, and reused via
    // the imported function.
    expect(code).not.toMatch(/\\u0000/);
  });

  it("opens no transaction, writes nothing and contains no effectivity window (D7, I2.11)", () => {
    expect(code).not.toMatch(/\.transaction\(/);
    expect(code).not.toMatch(/\.insert\(/);
    expect(code).not.toMatch(/\.update\(/);
    expect(code).not.toMatch(/\.delete\(/);
    expect(code).not.toMatch(/for\(\s*"update"\s*\)/);
    expect(code).not.toMatch(/effectiv/i);
    expect(code).not.toMatch(/as[_-]?of/i);
    expect(code).not.toMatch(/event_time/);
  });

  it("imports no next/* module (§7.2)", () => {
    expect(code).not.toMatch(/from\s*"next\//);
  });
});
