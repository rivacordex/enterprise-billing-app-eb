import { describe, expect, it } from "vitest";

import { loginSchema } from "@/validation/login.schema";

describe("loginSchema", () => {
  it("accepts a valid email and non-empty password", () => {
    const result = loginSchema.safeParse({
      email: "admin@example.com",
      password: "correct-password",
    });
    expect(result.success).toBe(true);
  });

  it("trims surrounding whitespace from the email before validating", () => {
    const result = loginSchema.safeParse({
      email: "  admin@example.com  ",
      password: "correct-password",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("admin@example.com");
    }
  });

  it("rejects an invalid email", () => {
    const result = loginSchema.safeParse({
      email: "not-an-email",
      password: "correct-password",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty password", () => {
    const result = loginSchema.safeParse({
      email: "admin@example.com",
      password: "",
    });
    expect(result.success).toBe(false);
  });
});
