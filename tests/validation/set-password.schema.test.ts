import { describe, expect, it, vi } from "vitest";

// `defaultPasswordSchema` (imported by `setPasswordSchema`) is built from
// `passwordPolicy` at module load — mocked to the documented defaults so
// this suite never depends on `lib/config`'s eager env validation.
vi.mock("@/lib/password-policy", () => ({
  passwordPolicy: {
    minLength: 15,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: true,
    specialChars: "!@#$%^&*()_+-=[]{}|;':\",./<>?",
  },
}));

import { setPasswordSchema } from "@/validation/set-password.schema";

const VALID = "ValidPassword123!";

describe("setPasswordSchema", () => {
  it("accepts matching, policy-compliant passwords", () => {
    const result = setPasswordSchema.safeParse({
      newPassword: VALID,
      confirmPassword: VALID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a newPassword shorter than the policy minimum", () => {
    const result = setPasswordSchema.safeParse({
      newPassword: "Short1!",
      confirmPassword: "Short1!",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.newPassword).toBeDefined();
    }
  });

  it("rejects a newPassword missing a required character class", () => {
    const result = setPasswordSchema.safeParse({
      newPassword: "alllowercase12345",
      confirmPassword: "alllowercase12345",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.newPassword).toContain(
        "Password must contain at least one uppercase letter.",
      );
    }
  });

  it("rejects mismatched passwords with an error on confirmPassword", () => {
    const result = setPasswordSchema.safeParse({
      newPassword: VALID,
      confirmPassword: "DifferentPassword123!",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.confirmPassword).toEqual([
        "Passwords do not match.",
      ]);
    }
  });
});
