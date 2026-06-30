import { describe, expect, it } from "vitest";

const FIXTURE_POLICY = {
  minLength: 15,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: true,
  specialChars: "!@#$%^&*()_+-=[]{}|;':\",./<>?",
};

import type { PasswordPolicy } from "@/types/password";
import {
  buildPasswordSchema,
  defaultPasswordSchema,
} from "@/validation/password";

const COMPLIANT = "ValidPassword123!";

describe("buildPasswordSchema", () => {
  it("accepts a password satisfying every rule", () => {
    const schema = buildPasswordSchema(FIXTURE_POLICY);
    expect(schema.safeParse(COMPLIANT).success).toBe(true);
  });

  it("rejects a password shorter than minLength with the length message", () => {
    const schema = buildPasswordSchema(FIXTURE_POLICY);
    const result = schema.safeParse("Short1!");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "Password must be at least 15 characters.",
      );
    }
  });

  it("rejects a 15+ char password missing uppercase", () => {
    const schema = buildPasswordSchema(FIXTURE_POLICY);
    const result = schema.safeParse("alllowercase123!");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "Password must contain at least one uppercase letter.",
      );
    }
  });

  it("rejects a password missing lowercase", () => {
    const schema = buildPasswordSchema(FIXTURE_POLICY);
    const result = schema.safeParse("ALLUPPERCASE123!");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "Password must contain at least one lowercase letter.",
      );
    }
  });

  it("rejects a password missing a number", () => {
    const schema = buildPasswordSchema(FIXTURE_POLICY);
    const result = schema.safeParse("NoNumbersHere!!!");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "Password must contain at least one number.",
      );
    }
  });

  it("rejects a password missing a special character", () => {
    const schema = buildPasswordSchema(FIXTURE_POLICY);
    const result = schema.safeParse("NoSpecialChars123");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "Password must contain at least one special character (!@#$%^&*()_+-=[]{}|;':\",./<>?).",
      );
    }
  });

  it("returns every failing rule in a single safeParse call, not just the first", () => {
    const schema = buildPasswordSchema(FIXTURE_POLICY);
    const result = schema.safeParse("short");
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.length).toBeGreaterThan(1);
      expect(messages).toContain("Password must be at least 15 characters.");
      expect(messages).toContain(
        "Password must contain at least one uppercase letter.",
      );
      expect(messages).toContain("Password must contain at least one number.");
    }
  });

  it("rejects a password longer than 128 characters with the max-length message", () => {
    const schema = buildPasswordSchema(FIXTURE_POLICY);
    // 129 chars, otherwise fully compliant (upper/lower/number/special).
    const tooLong = "Aa1!" + "a".repeat(125);
    expect(tooLong.length).toBe(129);
    const result = schema.safeParse(tooLong);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "Password must be at most 128 characters.",
      );
    }
  });

  it("accepts a fully compliant password of exactly 128 characters", () => {
    const schema = buildPasswordSchema(FIXTURE_POLICY);
    const atLimit = "Aa1!" + "a".repeat(124);
    expect(atLimit.length).toBe(128);
    expect(schema.safeParse(atLimit).success).toBe(true);
  });

  it("omits a rule's refine when that rule is disabled", () => {
    const policy: PasswordPolicy = { ...FIXTURE_POLICY, requireSpecial: false };
    const schema = buildPasswordSchema(policy);
    expect(schema.safeParse("ValidPassword123").success).toBe(true);
  });

  it("respects a custom minLength", () => {
    const policy: PasswordPolicy = { ...FIXTURE_POLICY, minLength: 8 };
    const schema = buildPasswordSchema(policy);
    expect(schema.safeParse("Abcdefg1!").success).toBe(true);
    expect(schema.safeParse("Abc1!").success).toBe(false);
  });

  it("produces the same result as a custom-policy schema for matching policies", () => {
    const schema = buildPasswordSchema(FIXTURE_POLICY);
    const other = buildPasswordSchema({ ...FIXTURE_POLICY });
    expect(schema.safeParse(COMPLIANT).success).toBe(
      other.safeParse(COMPLIANT).success,
    );
    expect(schema.safeParse("bad").success).toBe(
      other.safeParse("bad").success,
    );
  });
});

describe("defaultPasswordSchema", () => {
  it("matches buildPasswordSchema built from the app-level policy", () => {
    expect(defaultPasswordSchema.safeParse(COMPLIANT).success).toBe(true);
    expect(defaultPasswordSchema.safeParse("short").success).toBe(false);
  });
});
