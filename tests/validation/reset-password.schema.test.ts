import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { resetPasswordSchema } from "@/validation/reset-password.schema";

describe("resetPasswordSchema", () => {
  it("accepts a valid UUID", () => {
    const result = resetPasswordSchema.safeParse({ userId: randomUUID() });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID userId", () => {
    const result = resetPasswordSchema.safeParse({ userId: "not-a-uuid" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userId).toBeDefined();
    }
  });

  it("rejects an empty input", () => {
    const result = resetPasswordSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userId).toBeDefined();
    }
  });

  it("strips extra fields", () => {
    const result = resetPasswordSchema.safeParse({
      userId: randomUUID(),
      extra: "field",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("extra");
    }
  });
});
