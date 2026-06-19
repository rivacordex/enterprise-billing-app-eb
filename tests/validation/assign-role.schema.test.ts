import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { assignRoleSchema } from "@/validation/assign-role.schema";

describe("assignRoleSchema", () => {
  const validUserId = randomUUID();
  const validRoleId = randomUUID();

  it("accepts a valid input", () => {
    const result = assignRoleSchema.safeParse({
      userId: validUserId,
      roleId: validRoleId,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a userId that is not a valid UUID", () => {
    const result = assignRoleSchema.safeParse({
      userId: "not-a-uuid",
      roleId: validRoleId,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.userId).toBeDefined();
    }
  });

  it("rejects a roleId that is not a valid UUID", () => {
    const result = assignRoleSchema.safeParse({
      userId: validUserId,
      roleId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.roleId).toBeDefined();
    }
  });

  it("rejects a missing roleId", () => {
    const result = assignRoleSchema.safeParse({ userId: validUserId });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.roleId).toBeDefined();
    }
  });

  it("rejects an empty object", () => {
    const result = assignRoleSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors;
      expect(fieldErrors.userId).toBeDefined();
      expect(fieldErrors.roleId).toBeDefined();
    }
  });
});
