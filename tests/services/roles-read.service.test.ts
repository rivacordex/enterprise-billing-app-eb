import { beforeEach, describe, expect, it, vi } from "vitest";

// `roles-read.service.ts` imports the runtime `db` instance to pass into
// the mocked repositories below — mock `@/db/client` too so importing it
// never triggers `lib/config`'s eager env validation, mirroring
// tests/services/users-read.service.test.ts.
vi.mock("@/db/client", () => ({ db: {} }));

vi.mock("@/db/repositories/roles.repository", () => ({
  rolesRepository: {
    findAll: vi.fn(),
    findRoleById: vi.fn(),
    findAllRoles: vi.fn(),
  },
}));
vi.mock("@/db/repositories/role-permission-assign.repository", () => ({
  rolePermissionAssignRepository: {
    findMappingsForRole: vi.fn(),
    findMappingsForRoles: vi.fn(),
    findGrantsByRoleIds: vi.fn(),
  },
}));

import { rolesRepository } from "@/db/repositories/roles.repository";
import { rolePermissionAssignRepository } from "@/db/repositories/role-permission-assign.repository";
import {
  getAllRolesWithMappings,
  getRoleWithMappings,
} from "@/services/roles/roles-read.service";

const mockFindAll = vi.mocked(rolesRepository.findAll);
const mockFindRoleById = vi.mocked(rolesRepository.findRoleById);
const mockFindMappingsForRole = vi.mocked(
  rolePermissionAssignRepository.findMappingsForRole,
);
const mockFindMappingsForRoles = vi.mocked(
  rolePermissionAssignRepository.findMappingsForRoles,
);

const ADMIN_ROLE = {
  roleId: "role-admin",
  roleName: "ADMIN",
  roleDescr: "Full access",
  createdDatetime: new Date("2026-01-01T00:00:00Z"),
  lastModifiedDatetime: new Date("2026-01-01T00:00:00Z"),
};
const MANAGER_ROLE = {
  ...ADMIN_ROLE,
  roleId: "role-manager",
  roleName: "MANAGER",
};
const USER_ROLE = { ...ADMIN_ROLE, roleId: "role-user", roleName: "USER" };

const ADMIN_ASSIGNMENTS = [
  { permissionName: "users" as const, permissionType: "DELETE" as const },
  { permissionName: "roles" as const, permissionType: "DELETE" as const },
  {
    permissionName: "system_config" as const,
    permissionType: "DELETE" as const,
  },
  { permissionName: "audit_log" as const, permissionType: "READ" as const },
];

beforeEach(() => {
  mockFindAll.mockReset();
  mockFindRoleById.mockReset();
  mockFindMappingsForRole.mockReset();
  mockFindMappingsForRoles.mockReset();
});

describe("getAllRolesWithMappings", () => {
  it("returns 3 RoleWithMappings objects; ADMIN has 5 mapped entries, MANAGER/USER are all null", async () => {
    mockFindAll.mockResolvedValue([ADMIN_ROLE, MANAGER_ROLE, USER_ROLE]);
    mockFindMappingsForRoles.mockResolvedValue(
      ADMIN_ASSIGNMENTS.map((a) => ({ ...a, roleId: "role-admin" })),
    );

    const result = await getAllRolesWithMappings();

    expect(result).toHaveLength(3);
    const admin = result.find((r) => r.roleId === "role-admin")!;
    expect(admin.mappings).toEqual([
      { permissionName: "users", assignedLevel: "DELETE" },
      { permissionName: "roles", assignedLevel: "DELETE" },
      { permissionName: "system_config", assignedLevel: "DELETE" },
      { permissionName: "audit_log", assignedLevel: "READ" },
      { permissionName: "products", assignedLevel: null },
      { permissionName: "customers", assignedLevel: null },
    ]);
    const manager = result.find((r) => r.roleId === "role-manager")!;
    expect(manager.mappings.every((m) => m.assignedLevel === null)).toBe(true);
  });

  it("every mappings array has exactly PERMISSION_NAMES.length entries", async () => {
    mockFindAll.mockResolvedValue([ADMIN_ROLE]);
    mockFindMappingsForRoles.mockResolvedValue(
      ADMIN_ASSIGNMENTS.map((a) => ({ ...a, roleId: "role-admin" })),
    );

    const [role] = await getAllRolesWithMappings();
    expect(role!.mappings).toHaveLength(6);
  });

  it("mappings are always ordered users, roles, system_config, audit_log, products, customers", async () => {
    mockFindAll.mockResolvedValue([ADMIN_ROLE]);
    // Returned out of order on purpose.
    mockFindMappingsForRoles.mockResolvedValue(
      [...ADMIN_ASSIGNMENTS]
        .reverse()
        .map((a) => ({ ...a, roleId: "role-admin" })),
    );

    const [role] = await getAllRolesWithMappings();
    expect(role!.mappings.map((m) => m.permissionName)).toEqual([
      "users",
      "roles",
      "system_config",
      "audit_log",
      "products",
      "customers",
    ]);
  });
});

describe("getRoleWithMappings", () => {
  it("returns null and never calls findMappingsForRole when the role is not found", async () => {
    mockFindRoleById.mockResolvedValue(null);

    const result = await getRoleWithMappings("nonexistent-uuid");

    expect(result).toBeNull();
    expect(mockFindMappingsForRole).not.toHaveBeenCalled();
  });

  it("returns all 6 mappings as null when found with no assignments", async () => {
    mockFindRoleById.mockResolvedValue(MANAGER_ROLE);
    mockFindMappingsForRole.mockResolvedValue([]);

    const result = await getRoleWithMappings("role-manager");

    expect(result?.mappings.every((m) => m.assignedLevel === null)).toBe(true);
  });

  it("maps a partial assignment to the matching permission, others null", async () => {
    mockFindRoleById.mockResolvedValue(ADMIN_ROLE);
    mockFindMappingsForRole.mockResolvedValue([
      { permissionName: "users", permissionType: "DELETE" },
    ]);

    const result = await getRoleWithMappings("role-admin");

    expect(result?.mappings).toEqual([
      { permissionName: "users", assignedLevel: "DELETE" },
      { permissionName: "roles", assignedLevel: null },
      { permissionName: "system_config", assignedLevel: null },
      { permissionName: "audit_log", assignedLevel: null },
      { permissionName: "products", assignedLevel: null },
      { permissionName: "customers", assignedLevel: null },
    ]);
  });
});
