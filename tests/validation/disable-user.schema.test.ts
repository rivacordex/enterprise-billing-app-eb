import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { disableUserSchema } from "@/validation/disable-user.schema";

describe("disableUserSchema", () => {
  it("accepts a valid UUID", () => {
    const result = disableUserSchema.safeParse({ userId: randomUUID() });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID userId", () => {
    const result = disableUserSchema.safeParse({ userId: "not-a-uuid" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userId).toBeDefined();
    }
  });

  it("rejects an empty input", () => {
    const result = disableUserSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userId).toBeDefined();
    }
  });

  it("strips extra fields", () => {
    const result = disableUserSchema.safeParse({
      userId: randomUUID(),
      extra: "field",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("extra");
    }
  });
});
