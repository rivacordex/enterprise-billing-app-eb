import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { setPermissionLevelSchema } from "@/validation/set-permission-level.schema";

describe("setPermissionLevelSchema", () => {
  const validRoleId = randomUUID();

  it("accepts a valid input with a level", () => {
    const result = setPermissionLevelSchema.safeParse({
      roleId: validRoleId,
      permissionName: "users",
      level: "READ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        roleId: validRoleId,
        permissionName: "users",
        level: "READ",
      });
    }
  });

  it("accepts audit_log with level READ", () => {
    const result = setPermissionLevelSchema.safeParse({
      roleId: validRoleId,
      permissionName: "audit_log",
      level: "READ",
    });
    expect(result.success).toBe(true);
  });

  it("accepts level: null for users (remove mapping)", () => {
    const result = setPermissionLevelSchema.safeParse({
      roleId: validRoleId,
      permissionName: "users",
      level: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.level).toBeNull();
    }
  });

  it("accepts level: null for audit_log (schema does not block null on audit_log)", () => {
    const result = setPermissionLevelSchema.safeParse({
      roleId: validRoleId,
      permissionName: "audit_log",
      level: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID roleId", () => {
    const result = setPermissionLevelSchema.safeParse({
      roleId: "not-a-uuid",
      permissionName: "users",
      level: "READ",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.roleId).toBeDefined();
    }
  });

  it("rejects a permissionName not in PERMISSION_NAMES", () => {
    const result = setPermissionLevelSchema.safeParse({
      roleId: validRoleId,
      permissionName: "billing_runs",
      level: "READ",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.permissionName).toBeDefined();
    }
  });

  it("rejects a level not in PERMISSION_TYPES", () => {
    const result = setPermissionLevelSchema.safeParse({
      roleId: validRoleId,
      permissionName: "users",
      level: "SUPERADMIN",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.level).toBeDefined();
    }
  });

  it("rejects a missing level (not optional)", () => {
    const result = setPermissionLevelSchema.safeParse({
      roleId: validRoleId,
      permissionName: "users",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.level).toBeDefined();
    }
  });
});
