import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";

import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

describe("core.roles", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(roles).sort()).toEqual(
      [
        "role_id",
        "role_name",
        "role_descr",
        "created_datetime",
        "last_modified_datetime",
      ].sort(),
    );
  });
});

describe("core.permissions", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(permissions).sort()).toEqual(
      ["permission_id", "permission_name", "permission_info"].sort(),
    );
  });

  it("has no timestamp columns (static registry, Inv. #7)", () => {
    expect(columnNames(permissions)).not.toContain("created_datetime");
    expect(columnNames(permissions)).not.toContain("last_modified_datetime");
  });
});

describe("core.role_permission_assign", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(rolePermissionAssign).sort()).toEqual(
      [
        "role_permission_id",
        "ref_role_id",
        "ref_permission_id",
        "permission_type",
        "created_datetime",
        "last_modified_datetime",
      ].sort(),
    );
  });
});

describe("core.role_assign", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(roleAssign).sort()).toEqual(
      [
        "role_assign_id",
        "ref_user_id",
        "ref_role_id",
        "assigned_by",
        "created_datetime",
      ].sort(),
    );
  });

  it("does not carry a last_modified_datetime column (create/delete only, never mutated)", () => {
    expect(columnNames(roleAssign)).not.toContain("last_modified_datetime");
  });
});
