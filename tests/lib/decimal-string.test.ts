import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalDecimalString } from "@/lib/decimal-string";

// pm69-spec I4.1–I4.5 (§1.52, Inv. #68). The one helper that turns a
// `numeric` read-back into the canonical decimal string — never rounding,
// never parsing to `number`.

const D2_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["100.000000", "100"],
  ["0.050000", "0.05"],
  ["0.000000", "0"],
  ["1234567.123456", "1234567.123456"],
  ["100", "100"],
  ["5500.00", "5500"],
  ["100100", "100100"],
];

describe("canonicalDecimalString — the D2 contract", () => {
  it.each(D2_TABLE)("%j → %j", (input, expected) => {
    expect(canonicalDecimalString(input)).toBe(expected);
  });
});

describe("canonicalDecimalString — integer digits are never touched", () => {
  it.each([
    ["100100", "100100"],
    ["1000000.000000", "1000000"],
  ])("%j → %j", (input, expected) => {
    expect(canonicalDecimalString(input)).toBe(expected);
  });
});

describe("canonicalDecimalString — idempotence", () => {
  it.each(D2_TABLE.map(([input]) => input))(
    "is a fixed point after one pass for %j",
    (input) => {
      const once = canonicalDecimalString(input);
      expect(canonicalDecimalString(once)).toBe(once);
    },
  );
});

describe("canonicalDecimalString — refuses anything not a plain decimal", () => {
  it.each(["-1", "1e3", "1,000", "", " 100", "100.", ".5"])(
    "throws TypeError for %j",
    (input) => {
      expect(() => canonicalDecimalString(input)).toThrow(TypeError);
    },
  );
});

describe("lib/decimal-string.ts — purity (§7.15)", () => {
  it("has no imports", () => {
    const source = readFileSync(
      resolve(__dirname, "../../lib/decimal-string.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
