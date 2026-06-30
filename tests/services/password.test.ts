import { describe, expect, it, vi } from "vitest";

import { generateTempPassword } from "@/services/password";
import type { PasswordPolicy } from "@/types/password";
import { buildPasswordSchema } from "@/validation/password";

const DEFAULT_POLICY: PasswordPolicy = {
  minLength: 15,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: true,
  specialChars: "!@#$%^&*()_+-=[]{}|;':\",./<>?",
};

describe("generateTempPassword", () => {
  it("produces a string of at least the policy minLength", () => {
    const password = generateTempPassword(DEFAULT_POLICY);
    expect(password.length).toBeGreaterThanOrEqual(DEFAULT_POLICY.minLength);
  });

  it("contains at least one char from each enabled required class", () => {
    const password = generateTempPassword(DEFAULT_POLICY);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
    expect(/[!@#$%^&*()_+\-=[\]{}|;':",./<>?\\]/.test(password)).toBe(true);
  });

  it("passes buildPasswordSchema(policy).safeParse() for the same policy", () => {
    const schema = buildPasswordSchema(DEFAULT_POLICY);
    for (let i = 0; i < 25; i++) {
      const password = generateTempPassword(DEFAULT_POLICY);
      expect(schema.safeParse(password).success).toBe(true);
    }
  });

  it("respects a custom minLength and a relaxed rule set", () => {
    const policy: PasswordPolicy = {
      minLength: 8,
      requireUppercase: false,
      requireLowercase: true,
      requireNumber: true,
      requireSpecial: false,
      specialChars: "!@#",
    };
    const password = generateTempPassword(policy);
    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(buildPasswordSchema(policy).safeParse(password).success).toBe(true);
  });

  it("never calls Math.random", () => {
    const spy = vi.spyOn(Math, "random");
    generateTempPassword(DEFAULT_POLICY);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("produces unique passwords across 1000 calls", () => {
    const passwords = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      passwords.add(generateTempPassword(DEFAULT_POLICY));
    }
    expect(passwords.size).toBe(1000);
  });
});
