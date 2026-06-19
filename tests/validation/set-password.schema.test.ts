import { describe, expect, it } from "vitest";

import { setPasswordSchema } from "@/validation/set-password.schema";

describe("setPasswordSchema", () => {
  it("accepts matching passwords of at least 12 characters", () => {
    const result = setPasswordSchema.safeParse({
      newPassword: "ValidPassword123",
      confirmPassword: "ValidPassword123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a newPassword shorter than 12 characters", () => {
    const result = setPasswordSchema.safeParse({
      newPassword: "short1",
      confirmPassword: "short1",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.newPassword).toBeDefined();
    }
  });

  it("rejects a newPassword longer than 128 characters", () => {
    const tooLong = "a".repeat(129);
    const result = setPasswordSchema.safeParse({
      newPassword: tooLong,
      confirmPassword: tooLong,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.newPassword).toBeDefined();
    }
  });

  it("accepts exactly 12 and exactly 128 characters", () => {
    const min = "a".repeat(12);
    const max = "a".repeat(128);
    expect(
      setPasswordSchema.safeParse({ newPassword: min, confirmPassword: min })
        .success,
    ).toBe(true);
    expect(
      setPasswordSchema.safeParse({ newPassword: max, confirmPassword: max })
        .success,
    ).toBe(true);
  });

  it("rejects mismatched passwords with an error on confirmPassword", () => {
    const result = setPasswordSchema.safeParse({
      newPassword: "ValidPassword123",
      confirmPassword: "DifferentPassword123",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.confirmPassword).toEqual([
        "Passwords do not match.",
      ]);
    }
  });
});
