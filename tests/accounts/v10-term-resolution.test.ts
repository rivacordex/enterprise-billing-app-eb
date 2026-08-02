import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

import { resolveTerm } from "@/services/accounts/term-resolution";

// ac15-spec §3.7 — V10: term resolution = coalesce(override, cycleDefault).
// Pure-function unit tests (no DB required). Integration aspect — changing
// either value post-issuance does not re-derive issued dates — is a property
// of the caller stamping the value at generation time, not of resolveTerm
// itself. The stamped-due-date full proof lands with the Invoicing module.

describe("resolveTerm — pure unit tests (V10 / Inv. #13)", () => {
  it("returns the override when it is a positive integer", () => {
    expect(resolveTerm(14, 30)).toBe(14);
  });

  it("returns the override when it is zero (explicit 0-day term)", () => {
    expect(resolveTerm(0, 30)).toBe(0);
  });

  it("falls back to cycleDefault when override is null", () => {
    expect(resolveTerm(null, 30)).toBe(30);
  });

  it("falls back to cycleDefault when override is undefined", () => {
    expect(resolveTerm(undefined, 30)).toBe(30);
  });

  it("uses exact cycle default without rounding or coercion", () => {
    expect(resolveTerm(null, 7)).toBe(7);
    expect(resolveTerm(null, 45)).toBe(45);
    expect(resolveTerm(null, 0)).toBe(0);
  });

  it("override always wins regardless of how large cycleDefault is", () => {
    expect(resolveTerm(1, 999)).toBe(1);
    expect(resolveTerm(60, 30)).toBe(60);
  });

  it("is a pure function — calling it twice with the same args yields the same result", () => {
    const a = resolveTerm(21, 30);
    const b = resolveTerm(21, 30);
    expect(a).toBe(b);
  });
});

describe("term-resolution.ts — structural guardrails (ac15-spec §2.5)", () => {
  const src = readFileSync(
    resolve(__dirname, "../../services/accounts/term-resolution.ts"),
    "utf-8",
  );

  it("has no imports (pure function, no side effects)", () => {
    expect(src).not.toContain("import ");
  });

  it("uses nullish coalescing (??) for the coalesce (not || or ternary)", () => {
    expect(src).toContain("??");
  });

  it("has no TODO or console.*", () => {
    expect(src).not.toContain("TODO");
    expect(src).not.toContain("console.");
  });
});

describe("term resolution — post-issuance freeze property (Inv. #13 / ac15-spec §2.5)", () => {
  // This group documents the freeze property in code, even though the
  // full stamped-due-date integration test lands with the Invoicing module.
  // The property holds because callers capture resolveTerm()'s output at
  // document generation time and store it; subsequent catalog changes don't
  // touch already-written rows.

  it("resolveTerm is referentially transparent — memoising the result preserves it", () => {
    const paymentDueDaysAtIssuance = resolveTerm(null, 30);
    // Simulate a cycle change after issuance:
    const cycleDefaultChangedAfterIssuance = 45;
    const resolvedAgain = resolveTerm(null, cycleDefaultChangedAfterIssuance);
    // The already-stamped value (30) is unaffected by the later catalog change (45).
    expect(paymentDueDaysAtIssuance).toBe(30);
    expect(resolvedAgain).toBe(45);
    expect(paymentDueDaysAtIssuance).not.toBe(resolvedAgain);
  });

  it("BAN override takes precedence; override change after issuance is a separate resolution call", () => {
    // At issuance: override = 14, cycle default = 30 → stamped = 14
    const stampedAtIssuance = resolveTerm(14, 30);
    // BAN override later changed to 21; any new resolution uses the new override,
    // but the already-stamped 14 is not retroactively updated.
    const resolvedAfterOverrideChange = resolveTerm(21, 30);
    expect(stampedAtIssuance).toBe(14);
    expect(resolvedAfterOverrideChange).toBe(21);
  });
});
