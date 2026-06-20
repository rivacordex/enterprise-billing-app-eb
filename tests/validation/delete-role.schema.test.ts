import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { deleteRoleSchema } from "@/validation/delete-role.schema";

describe("deleteRoleSchema", () => {
  it("accepts a valid roleId", () => {
    const result = deleteRoleSchema.safeParse({ roleId: randomUUID() });
    expect(result.success).toBe(true);
  });

  it("rejects a roleId that is not a valid UUID", () => {
    const result = deleteRoleSchema.safeParse({ roleId: "not-a-uuid" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.roleId).toBeDefined();
    }
  });

  it("rejects a missing roleId", () => {
    const result = deleteRoleSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
