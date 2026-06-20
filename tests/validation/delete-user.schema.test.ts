import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { deleteUserSchema } from "@/validation/delete-user.schema";

describe("deleteUserSchema", () => {
  it("accepts a valid UUID", () => {
    const result = deleteUserSchema.safeParse({ userId: randomUUID() });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID userId", () => {
    const result = deleteUserSchema.safeParse({ userId: "not-a-uuid" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userId).toBeDefined();
    }
  });

  it("rejects a missing userId", () => {
    const result = deleteUserSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userId).toBeDefined();
    }
  });

  it("strips extra fields", () => {
    const result = deleteUserSchema.safeParse({
      userId: randomUUID(),
      extra: "field",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("extra");
    }
  });
});
