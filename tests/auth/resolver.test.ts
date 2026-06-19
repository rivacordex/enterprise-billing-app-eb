import { beforeEach, describe, expect, it, vi } from "vitest";

// `auth/resolver.ts` imports the runtime `db` instance to pass into the
// mocked repositories below — mock `@/db/client` too so importing it never
// triggers `lib/config`'s eager env validation (no DATABASE_URL needed for
// this DB-free unit suite).
vi.mock("@/db/client", () => ({ db: {} }));

vi.mock("@/db/repositories/role-assign.repository", () => ({
  roleAssignRepository: { findRoleIdsByUserId: vi.fn() },
}));

vi.mock("@/db/repositories/role-permission-assign.repository", () => ({
  rolePermissionAssignRepository: { findGrantsByRoleIds: vi.fn() },
}));

import { resolveEffectivePermissions } from "@/auth/resolver";
import { roleAssignRepository } from "@/db/repositories/role-assign.repository";
import { rolePermissionAssignRepository } from "@/db/repositories/role-permission-assign.repository";

const findRoleIdsByUserId = vi.mocked(roleAssignRepository.findRoleIdsByUserId);
const findGrantsByRoleIds = vi.mocked(
  rolePermissionAssignRepository.findGrantsByRoleIds,
);

beforeEach(() => {
  findRoleIdsByUserId.mockReset();
  findGrantsByRoleIds.mockReset();
});

describe("resolveEffectivePermissions", () => {
  it("returns all-null when the user has no roles assigned", async () => {
    findRoleIdsByUserId.mockResolvedValue([]);

    const result = await resolveEffectivePermissions("user-1");

    expect(result).toEqual({
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
    });
    expect(findGrantsByRoleIds).not.toHaveBeenCalled();
  });

  it("reflects a single role with one grant", async () => {
    findRoleIdsByUserId.mockResolvedValue(["admin-role"]);
    findGrantsByRoleIds.mockResolvedValue([
      { permissionName: "users", permissionType: "DELETE" },
    ]);

    const result = await resolveEffectivePermissions("user-1");

    expect(result).toEqual({
      users: "DELETE",
      roles: null,
      system_config: null,
      audit_log: null,
    });
  });

  it("reflects the full ADMIN seed", async () => {
    findRoleIdsByUserId.mockResolvedValue(["admin-role"]);
    findGrantsByRoleIds.mockResolvedValue([
      { permissionName: "users", permissionType: "DELETE" },
      { permissionName: "roles", permissionType: "DELETE" },
      { permissionName: "system_config", permissionType: "DELETE" },
      { permissionName: "audit_log", permissionType: "READ" },
    ]);

    const result = await resolveEffectivePermissions("admin-user");

    expect(result).toEqual({
      users: "DELETE",
      roles: "DELETE",
      system_config: "DELETE",
      audit_log: "READ",
    });
  });

  it("takes the highest level across two overlapping roles", async () => {
    findRoleIdsByUserId.mockResolvedValue(["role-a", "role-b"]);
    findGrantsByRoleIds.mockResolvedValue([
      { permissionName: "users", permissionType: "READ" },
      { permissionName: "users", permissionType: "EDIT" },
    ]);

    const result = await resolveEffectivePermissions("user-1");

    expect(result.users).toBe("EDIT");
  });

  it("DELETE wins over READ on the same permission across two roles", async () => {
    findRoleIdsByUserId.mockResolvedValue(["role-a", "role-b"]);
    findGrantsByRoleIds.mockResolvedValue([
      { permissionName: "users", permissionType: "DELETE" },
      { permissionName: "users", permissionType: "READ" },
    ]);

    const result = await resolveEffectivePermissions("user-1");

    expect(result.users).toBe("DELETE");
  });

  it("returns all-null when the assigned role has no permission_assign rows", async () => {
    findRoleIdsByUserId.mockResolvedValue(["empty-role"]);
    findGrantsByRoleIds.mockResolvedValue([]);

    const result = await resolveEffectivePermissions("user-1");

    expect(result).toEqual({
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
    });
  });

  it("never caches — two calls make two round-trips", async () => {
    findRoleIdsByUserId.mockResolvedValue([]);

    await resolveEffectivePermissions("user-1");
    await resolveEffectivePermissions("user-1");

    expect(findRoleIdsByUserId).toHaveBeenCalledTimes(2);
  });
});
