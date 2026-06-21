import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { updateConfigValueSchema } from "@/validation/update-config.schema";

describe("updateConfigValueSchema", () => {
  it("accepts a valid UUID configId and a string configValue", () => {
    const result = updateConfigValueSchema.safeParse({
      configId: randomUUID(),
      configValue: "hello",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid UUID configId and a null configValue", () => {
    const result = updateConfigValueSchema.safeParse({
      configId: randomUUID(),
      configValue: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid UUID configId", () => {
    const result = updateConfigValueSchema.safeParse({
      configId: "not-a-uuid",
      configValue: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.configId).toBeDefined();
    }
  });

  it("rejects a configValue exceeding 2000 characters", () => {
    const result = updateConfigValueSchema.safeParse({
      configId: randomUUID(),
      configValue: "x".repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a configValue of exactly 2000 characters", () => {
    const result = updateConfigValueSchema.safeParse({
      configId: randomUUID(),
      configValue: "x".repeat(2000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing configId", () => {
    const result = updateConfigValueSchema.safeParse({ configValue: "x" });
    expect(result.success).toBe(false);
  });

  it("strips unknown extra fields", () => {
    const result = updateConfigValueSchema.safeParse({
      configId: randomUUID(),
      configValue: "x",
      extra: "field",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("extra");
    }
  });
});
