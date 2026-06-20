import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  editRoleFieldsSchema,
  updateRoleSchema,
} from "@/validation/update-role.schema";

describe("updateRoleSchema", () => {
  const validRoleId = randomUUID();

  it("accepts a valid input", () => {
    const result = updateRoleSchema.safeParse({
      roleId: validRoleId,
      roleName: "Finance",
      roleDescr: "Desc",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a roleId that is not a valid UUID", () => {
    const result = updateRoleSchema.safeParse({
      roleId: "not-a-uuid",
      roleName: "Finance",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.roleId).toBeDefined();
    }
  });

  it("rejects an empty roleName", () => {
    const result = updateRoleSchema.safeParse({
      roleId: validRoleId,
      roleName: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.roleName).toBeDefined();
    }
  });

  it("transforms a missing roleDescr to null", () => {
    const result = updateRoleSchema.safeParse({
      roleId: validRoleId,
      roleName: "X",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleDescr).toBeNull();
    }
  });
});

describe("editRoleFieldsSchema", () => {
  it("validates roleName/roleDescr without requiring roleId", () => {
    const result = editRoleFieldsSchema.safeParse({ roleName: "Finance" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleDescr).toBeNull();
    }
  });

  it("rejects an empty roleName", () => {
    const result = editRoleFieldsSchema.safeParse({ roleName: "" });
    expect(result.success).toBe(false);
  });
});
