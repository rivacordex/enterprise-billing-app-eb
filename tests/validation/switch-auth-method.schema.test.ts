import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { switchAuthMethodSchema } from "@/validation/switch-auth-method.schema";

describe("switchAuthMethodSchema", () => {
  it("accepts a valid UUID with newAuthMethod SSO", () => {
    const result = switchAuthMethodSchema.safeParse({
      userId: randomUUID(),
      newAuthMethod: "SSO",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid UUID with newAuthMethod LOCAL", () => {
    const result = switchAuthMethodSchema.safeParse({
      userId: randomUUID(),
      newAuthMethod: "LOCAL",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID userId", () => {
    const result = switchAuthMethodSchema.safeParse({
      userId: "not-a-uuid",
      newAuthMethod: "SSO",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userId).toBeDefined();
    }
  });

  it("rejects an unknown newAuthMethod", () => {
    const result = switchAuthMethodSchema.safeParse({
      userId: randomUUID(),
      newAuthMethod: "PASSKEY",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.newAuthMethod).toBeDefined();
    }
  });

  it("rejects a missing newAuthMethod", () => {
    const result = switchAuthMethodSchema.safeParse({ userId: randomUUID() });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.newAuthMethod).toBeDefined();
    }
  });

  it("strips extra fields", () => {
    const result = switchAuthMethodSchema.safeParse({
      userId: randomUUID(),
      newAuthMethod: "SSO",
      extra: "field",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("extra");
    }
  });
});
