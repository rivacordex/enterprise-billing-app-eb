import { describe, expect, it } from "vitest";

import { createRoleSchema } from "@/validation/create-role.schema";

describe("createRoleSchema", () => {
  it("accepts a valid input and preserves both fields", () => {
    const result = createRoleSchema.safeParse({
      roleName: "Finance",
      roleDescr: "Finance team",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        roleName: "Finance",
        roleDescr: "Finance team",
      });
    }
  });

  it("trims roleName and transforms a missing roleDescr to null", () => {
    const result = createRoleSchema.safeParse({ roleName: "  Finance  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleName).toBe("Finance");
      expect(result.data.roleDescr).toBeNull();
    }
  });

  it("rejects an empty roleName", () => {
    const result = createRoleSchema.safeParse({ roleName: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.roleName).toBeDefined();
    }
  });

  it("rejects a roleName longer than 100 characters", () => {
    const result = createRoleSchema.safeParse({ roleName: "A".repeat(101) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.roleName).toBeDefined();
    }
  });

  it("rejects a roleDescr longer than 500 characters", () => {
    const result = createRoleSchema.safeParse({
      roleName: "X",
      roleDescr: "D".repeat(501),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.roleDescr).toBeDefined();
    }
  });

  it("transforms an empty-string roleDescr to null", () => {
    const result = createRoleSchema.safeParse({
      roleName: "X",
      roleDescr: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleDescr).toBeNull();
    }
  });

  it("accepts a null roleDescr", () => {
    const result = createRoleSchema.safeParse({
      roleName: "X",
      roleDescr: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleDescr).toBeNull();
    }
  });

  it("transforms an undefined roleDescr to null", () => {
    const result = createRoleSchema.safeParse({
      roleName: "X",
      roleDescr: undefined,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roleDescr).toBeNull();
    }
  });
});
