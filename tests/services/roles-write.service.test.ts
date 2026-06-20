import { beforeEach, describe, expect, it, vi } from "vitest";

// `roles-write.service.ts` imports the runtime `db` instance to open its own
// transaction — mock `@/db/client` so importing it never triggers
// `lib/config`'s eager env validation, mirroring
// tests/services/users-write.service.test.ts. `db.transaction` runs the
// callback against the same mocked `tx` handle the repository mocks below
// observe.
const txStub = {};
vi.mock("@/db/client", () => ({
  db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)) },
}));

vi.mock("@/db/repositories/roles.repository", () => ({
  rolesRepository: {
    findRoleById: vi.fn(),
    findRoleByName: vi.fn(),
    insertRole: vi.fn(),
    updateRoleNameDescr: vi.fn(),
    deleteRoleById: vi.fn(),
  },
}));
vi.mock("@/db/repositories/permissions.repository", () => ({
  permissionsRepository: {
    findByName: vi.fn(),
  },
}));
vi.mock("@/db/repositories/role-permission-assign.repository", () => ({
  rolePermissionAssignRepository: {
    findGrantsByRoleIds: vi.fn(),
    findMappingsForRole: vi.fn(),
    upsertRolePermission: vi.fn(),
    deleteRolePermission: vi.fn(),
    deleteMappingsForRole: vi.fn(),
  },
}));
vi.mock("@/db/repositories/role-assign.repository", () => ({
  roleAssignRepository: {
    countByRoleId: vi.fn(),
  },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));

import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { permissionsRepository } from "@/db/repositories/permissions.repository";
import { roleAssignRepository } from "@/db/repositories/role-assign.repository";
import { rolePermissionAssignRepository } from "@/db/repositories/role-permission-assign.repository";
import { rolesRepository } from "@/db/repositories/roles.repository";
import {
  createRole,
  deleteRole,
  setRolePermissionLevel,
  updateRole,
} from "@/services/roles/roles-write.service";
import type { CreateRoleInput } from "@/validation/create-role.schema";
import type { DeleteRoleInput } from "@/validation/delete-role.schema";
import type { SetPermissionLevelInput } from "@/validation/set-permission-level.schema";
import type { UpdateRoleInput } from "@/validation/update-role.schema";

const mockFindRoleById = vi.mocked(rolesRepository.findRoleById);
const mockFindRoleByName = vi.mocked(rolesRepository.findRoleByName);
const mockInsertRole = vi.mocked(rolesRepository.insertRole);
const mockUpdateRoleNameDescr = vi.mocked(rolesRepository.updateRoleNameDescr);
const mockDeleteRoleById = vi.mocked(rolesRepository.deleteRoleById);
const mockFindByName = vi.mocked(permissionsRepository.findByName);
const mockFindMappingsForRole = vi.mocked(
  rolePermissionAssignRepository.findMappingsForRole,
);
const mockUpsertRolePermission = vi.mocked(
  rolePermissionAssignRepository.upsertRolePermission,
);
const mockDeleteRolePermission = vi.mocked(
  rolePermissionAssignRepository.deleteRolePermission,
);
const mockDeleteMappingsForRole = vi.mocked(
  rolePermissionAssignRepository.deleteMappingsForRole,
);
const mockCountByRoleId = vi.mocked(roleAssignRepository.countByRoleId);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

const ACTOR_ID = "actor-1";

beforeEach(() => {
  mockFindRoleById.mockReset();
  mockFindRoleByName.mockReset();
  mockInsertRole.mockReset();
  mockUpdateRoleNameDescr.mockReset();
  mockDeleteRoleById.mockReset();
  mockFindByName.mockReset();
  mockFindMappingsForRole.mockReset();
  mockUpsertRolePermission.mockReset();
  mockDeleteRolePermission.mockReset();
  mockDeleteMappingsForRole.mockReset();
  mockCountByRoleId.mockReset();
  mockInsertAuditEvent.mockReset();
});

describe("createRole", () => {
  const input: CreateRoleInput = {
    roleName: "Finance",
    roleDescr: "Finance team",
  };

  it("inserts the role and writes a ROLE_CREATED audit event on the happy path", async () => {
    mockFindRoleByName.mockResolvedValue(null);
    mockInsertRole.mockResolvedValue({ roleId: "role-1" });

    const result = await createRole(input, ACTOR_ID);

    expect(mockInsertRole).toHaveBeenCalledWith(expect.anything(), input);
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(expect.anything(), {
      eventType: "ROLE_CREATED",
      actorUserId: ACTOR_ID,
      targetEntity: "ROLES",
      targetId: "role-1",
      beforeData: null,
      afterData: { roleName: "Finance", roleDescr: "Finance team" },
    });
    expect(result).toEqual({ ok: true, roleId: "role-1" });
  });

  it("returns NAME_CONFLICT without inserting or auditing when the name exists", async () => {
    mockFindRoleByName.mockResolvedValue({
      roleId: "other-id",
      roleName: "Finance",
      roleDescr: null,
      createdDatetime: new Date(),
      lastModifiedDatetime: new Date(),
    });

    const result = await createRole(input, ACTOR_ID);

    expect(result).toEqual({ ok: false, code: "NAME_CONFLICT" });
    expect(mockInsertRole).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("treats a case-insensitive match as a conflict", async () => {
    mockFindRoleByName.mockResolvedValue({
      roleId: "other-id",
      roleName: "Finance",
      roleDescr: null,
      createdDatetime: new Date(),
      lastModifiedDatetime: new Date(),
    });

    const result = await createRole(
      { roleName: "finance", roleDescr: null },
      ACTOR_ID,
    );

    expect(result).toEqual({ ok: false, code: "NAME_CONFLICT" });
  });

  it("propagates the error and writes no audit event when insertRole throws", async () => {
    mockFindRoleByName.mockResolvedValue(null);
    mockInsertRole.mockRejectedValue(new Error("db exploded"));

    await expect(createRole(input, ACTOR_ID)).rejects.toThrow("db exploded");
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("passes a null roleDescr through to insertRole and the audit afterData", async () => {
    mockFindRoleByName.mockResolvedValue(null);
    mockInsertRole.mockResolvedValue({ roleId: "role-1" });

    await createRole({ roleName: "Finance", roleDescr: null }, ACTOR_ID);

    expect(mockInsertRole).toHaveBeenCalledWith(expect.anything(), {
      roleName: "Finance",
      roleDescr: null,
    });
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        afterData: { roleName: "Finance", roleDescr: null },
      }),
    );
  });
});

describe("updateRole", () => {
  const EXISTING_ROLE = {
    roleId: "role-1",
    roleName: "Old Name",
    roleDescr: "old",
    createdDatetime: new Date(),
    lastModifiedDatetime: new Date(),
  };

  const input: UpdateRoleInput = {
    roleId: "role-1",
    roleName: "New Name",
    roleDescr: "new",
  };

  it("updates the role and writes a ROLE_UPDATED audit event on the happy path", async () => {
    mockFindRoleById.mockResolvedValue(EXISTING_ROLE);
    mockFindRoleByName.mockResolvedValue(null);

    const result = await updateRole(input, ACTOR_ID);

    expect(mockUpdateRoleNameDescr).toHaveBeenCalledWith(
      expect.anything(),
      "role-1",
      { roleName: "New Name", roleDescr: "new" },
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(expect.anything(), {
      eventType: "ROLE_UPDATED",
      actorUserId: ACTOR_ID,
      targetEntity: "ROLES",
      targetId: "role-1",
      beforeData: { roleName: "Old Name", roleDescr: "old" },
      afterData: { roleName: "New Name", roleDescr: "new" },
    });
    expect(result).toEqual({ ok: true });
  });

  it("is not a conflict when the matched name belongs to the same role being edited", async () => {
    mockFindRoleById.mockResolvedValue(EXISTING_ROLE);
    mockFindRoleByName.mockResolvedValue({
      ...EXISTING_ROLE,
      roleName: "New Name",
    });

    const result = await updateRole(input, ACTOR_ID);

    expect(result).toEqual({ ok: true });
    expect(mockUpdateRoleNameDescr).toHaveBeenCalled();
  });

  it("returns NAME_CONFLICT when the matched name belongs to a different role", async () => {
    mockFindRoleById.mockResolvedValue(EXISTING_ROLE);
    mockFindRoleByName.mockResolvedValue({
      ...EXISTING_ROLE,
      roleId: "other-role-id",
      roleName: "New Name",
    });

    const result = await updateRole(input, ACTOR_ID);

    expect(result).toEqual({ ok: false, code: "NAME_CONFLICT" });
    expect(mockUpdateRoleNameDescr).not.toHaveBeenCalled();
  });

  it("returns ROLE_NOT_FOUND without writing when the role doesn't exist", async () => {
    mockFindRoleById.mockResolvedValue(null);

    const result = await updateRole(input, ACTOR_ID);

    expect(result).toEqual({ ok: false, code: "ROLE_NOT_FOUND" });
    expect(mockUpdateRoleNameDescr).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("short-circuits with ok:true and no DB write when name and descr are unchanged", async () => {
    mockFindRoleById.mockResolvedValue(EXISTING_ROLE);
    mockFindRoleByName.mockResolvedValue(EXISTING_ROLE);

    const result = await updateRole(
      { roleId: "role-1", roleName: "Old Name", roleDescr: "old" },
      ACTOR_ID,
    );

    expect(result).toEqual({ ok: true });
    expect(mockUpdateRoleNameDescr).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("records the before-snapshot when the description is cleared to null", async () => {
    mockFindRoleById.mockResolvedValue(EXISTING_ROLE);
    mockFindRoleByName.mockResolvedValue(null);

    await updateRole(
      { roleId: "role-1", roleName: "Old Name", roleDescr: null },
      ACTOR_ID,
    );

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        beforeData: { roleName: "Old Name", roleDescr: "old" },
        afterData: { roleName: "Old Name", roleDescr: null },
      }),
    );
  });

  it("propagates the error and writes no audit event when updateRoleNameDescr throws", async () => {
    mockFindRoleById.mockResolvedValue(EXISTING_ROLE);
    mockFindRoleByName.mockResolvedValue(null);
    mockUpdateRoleNameDescr.mockRejectedValue(new Error("db exploded"));

    await expect(updateRole(input, ACTOR_ID)).rejects.toThrow("db exploded");
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});

describe("setRolePermissionLevel", () => {
  const ROLE = {
    roleId: "role-1",
    roleName: "MANAGER",
    roleDescr: null,
    createdDatetime: new Date(),
    lastModifiedDatetime: new Date(),
  };

  const PERMISSION = {
    permissionId: "perm-users",
    permissionName: "users",
    permissionInfo: "Users",
  };

  function input(
    overrides: Partial<SetPermissionLevelInput> = {},
  ): SetPermissionLevelInput {
    return {
      roleId: "role-1",
      permissionName: "users",
      level: "READ",
      ...overrides,
    };
  }

  it("adds a new mapping (null -> READ)", async () => {
    mockFindRoleById.mockResolvedValue(ROLE);
    mockFindByName.mockResolvedValue(PERMISSION);
    mockFindMappingsForRole.mockResolvedValue([]);

    const result = await setRolePermissionLevel(input(), ACTOR_ID);

    expect(mockUpsertRolePermission).toHaveBeenCalledWith(expect.anything(), {
      roleId: "role-1",
      permissionId: "perm-users",
      permissionType: "READ",
    });
    expect(mockDeleteRolePermission).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(expect.anything(), {
      eventType: "PERMISSION_MAPPING_CHANGED",
      actorUserId: ACTOR_ID,
      targetEntity: "ROLE_PERMISSION_ASSIGN",
      targetId: "role-1",
      beforeData: { roleName: "MANAGER", permissionName: "users", level: null },
      afterData: {
        roleName: "MANAGER",
        permissionName: "users",
        level: "READ",
      },
    });
    expect(result).toEqual({ ok: true });
  });

  it("updates an existing mapping (READ -> DELETE)", async () => {
    mockFindRoleById.mockResolvedValue(ROLE);
    mockFindByName.mockResolvedValue(PERMISSION);
    mockFindMappingsForRole.mockResolvedValue([
      { permissionName: "users", permissionType: "READ" },
    ]);

    const result = await setRolePermissionLevel(
      input({ level: "DELETE" }),
      ACTOR_ID,
    );

    expect(mockUpsertRolePermission).toHaveBeenCalledWith(expect.anything(), {
      roleId: "role-1",
      permissionId: "perm-users",
      permissionType: "DELETE",
    });
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        beforeData: expect.objectContaining({ level: "READ" }),
        afterData: expect.objectContaining({ level: "DELETE" }),
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("removes a mapping (DELETE -> null)", async () => {
    mockFindRoleById.mockResolvedValue(ROLE);
    mockFindByName.mockResolvedValue(PERMISSION);
    mockFindMappingsForRole.mockResolvedValue([
      { permissionName: "users", permissionType: "DELETE" },
    ]);

    const result = await setRolePermissionLevel(
      input({ level: null }),
      ACTOR_ID,
    );

    expect(mockDeleteRolePermission).toHaveBeenCalledWith(expect.anything(), {
      roleId: "role-1",
      permissionId: "perm-users",
    });
    expect(mockUpsertRolePermission).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        afterData: expect.objectContaining({ level: null }),
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("short-circuits with no DB write when the level is unchanged", async () => {
    mockFindRoleById.mockResolvedValue(ROLE);
    mockFindByName.mockResolvedValue(PERMISSION);
    mockFindMappingsForRole.mockResolvedValue([
      { permissionName: "users", permissionType: "READ" },
    ]);

    const result = await setRolePermissionLevel(
      input({ level: "READ" }),
      ACTOR_ID,
    );

    expect(result).toEqual({ ok: true });
    expect(mockUpsertRolePermission).not.toHaveBeenCalled();
    expect(mockDeleteRolePermission).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("short-circuits with no DB write when both previous and new level are null", async () => {
    mockFindRoleById.mockResolvedValue(ROLE);
    mockFindByName.mockResolvedValue(PERMISSION);
    mockFindMappingsForRole.mockResolvedValue([]);

    const result = await setRolePermissionLevel(
      input({ level: null }),
      ACTOR_ID,
    );

    expect(result).toEqual({ ok: true });
    expect(mockUpsertRolePermission).not.toHaveBeenCalled();
    expect(mockDeleteRolePermission).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("rejects audit_log + EDIT before any DB reads", async () => {
    const result = await setRolePermissionLevel(
      input({ permissionName: "audit_log", level: "EDIT" }),
      ACTOR_ID,
    );

    expect(result).toEqual({ ok: false, code: "AUDIT_LOG_READONLY" });
    expect(mockFindRoleById).not.toHaveBeenCalled();
    expect(mockUpsertRolePermission).not.toHaveBeenCalled();
  });

  it("rejects audit_log + DELETE before any DB reads", async () => {
    const result = await setRolePermissionLevel(
      input({ permissionName: "audit_log", level: "DELETE" }),
      ACTOR_ID,
    );

    expect(result).toEqual({ ok: false, code: "AUDIT_LOG_READONLY" });
    expect(mockFindRoleById).not.toHaveBeenCalled();
  });

  it("allows audit_log + READ", async () => {
    mockFindRoleById.mockResolvedValue(ROLE);
    mockFindByName.mockResolvedValue({
      ...PERMISSION,
      permissionId: "perm-audit",
      permissionName: "audit_log",
    });
    mockFindMappingsForRole.mockResolvedValue([]);

    const result = await setRolePermissionLevel(
      input({ permissionName: "audit_log", level: "READ" }),
      ACTOR_ID,
    );

    expect(result).toEqual({ ok: true });
    expect(mockUpsertRolePermission).toHaveBeenCalledWith(expect.anything(), {
      roleId: "role-1",
      permissionId: "perm-audit",
      permissionType: "READ",
    });
  });

  it("allows audit_log + null", async () => {
    mockFindRoleById.mockResolvedValue(ROLE);
    mockFindByName.mockResolvedValue({
      ...PERMISSION,
      permissionId: "perm-audit",
      permissionName: "audit_log",
    });
    mockFindMappingsForRole.mockResolvedValue([
      { permissionName: "audit_log", permissionType: "READ" },
    ]);

    const result = await setRolePermissionLevel(
      input({ permissionName: "audit_log", level: null }),
      ACTOR_ID,
    );

    expect(result).toEqual({ ok: true });
    expect(mockDeleteRolePermission).toHaveBeenCalled();
  });

  it("returns ROLE_NOT_FOUND without writing when the role doesn't exist", async () => {
    mockFindRoleById.mockResolvedValue(null);

    const result = await setRolePermissionLevel(input(), ACTOR_ID);

    expect(result).toEqual({ ok: false, code: "ROLE_NOT_FOUND" });
    expect(mockUpsertRolePermission).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("returns PERMISSION_NOT_FOUND when the permission row is missing", async () => {
    mockFindRoleById.mockResolvedValue(ROLE);
    mockFindByName.mockResolvedValue(null);

    const result = await setRolePermissionLevel(input(), ACTOR_ID);

    expect(result).toEqual({ ok: false, code: "PERMISSION_NOT_FOUND" });
    expect(mockUpsertRolePermission).not.toHaveBeenCalled();
  });

  it("captures the before-snapshot correctly regardless of the after value", async () => {
    mockFindRoleById.mockResolvedValue(ROLE);
    mockFindByName.mockResolvedValue(PERMISSION);
    mockFindMappingsForRole.mockResolvedValue([
      { permissionName: "users", permissionType: "DELETE" },
    ]);

    await setRolePermissionLevel(input({ level: "READ" }), ACTOR_ID);

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        beforeData: expect.objectContaining({ level: "DELETE" }),
      }),
    );
  });

  it("propagates the error and writes no audit event when upsertRolePermission throws", async () => {
    mockFindRoleById.mockResolvedValue(ROLE);
    mockFindByName.mockResolvedValue(PERMISSION);
    mockFindMappingsForRole.mockResolvedValue([]);
    mockUpsertRolePermission.mockRejectedValue(new Error("db exploded"));

    await expect(setRolePermissionLevel(input(), ACTOR_ID)).rejects.toThrow(
      "db exploded",
    );
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("includes roleName in both before and after audit snapshots", async () => {
    mockFindRoleById.mockResolvedValue(ROLE);
    mockFindByName.mockResolvedValue(PERMISSION);
    mockFindMappingsForRole.mockResolvedValue([]);

    await setRolePermissionLevel(input(), ACTOR_ID);

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        beforeData: expect.objectContaining({ roleName: "MANAGER" }),
        afterData: expect.objectContaining({ roleName: "MANAGER" }),
      }),
    );
  });
});

describe("deleteRole", () => {
  const CUSTOM_ROLE = {
    roleId: "role-1",
    roleName: "Finance",
    roleDescr: "Finance team",
    createdDatetime: new Date(),
    lastModifiedDatetime: new Date(),
  };

  const input: DeleteRoleInput = { roleId: "role-1" };

  it("returns ROLE_NOT_FOUND without deleting or auditing when the role doesn't exist", async () => {
    mockFindRoleById.mockResolvedValue(null);

    const result = await deleteRole(input, ACTOR_ID);

    expect(result).toEqual({ ok: false, code: "ROLE_NOT_FOUND" });
    expect(mockCountByRoleId).not.toHaveBeenCalled();
    expect(mockDeleteRoleById).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "MANAGER", "USER"])(
    "returns SEEDED_ROLE for '%s' without deleting or auditing",
    async (roleName) => {
      mockFindRoleById.mockResolvedValue({ ...CUSTOM_ROLE, roleName });

      const result = await deleteRole(input, ACTOR_ID);

      expect(result).toEqual({ ok: false, code: "SEEDED_ROLE" });
      expect(mockCountByRoleId).not.toHaveBeenCalled();
      expect(mockDeleteRoleById).not.toHaveBeenCalled();
      expect(mockInsertAuditEvent).not.toHaveBeenCalled();
    },
  );

  it("returns ROLE_IN_USE with the assigned count without deleting or auditing", async () => {
    mockFindRoleById.mockResolvedValue(CUSTOM_ROLE);
    mockCountByRoleId.mockResolvedValue(3);

    const result = await deleteRole(input, ACTOR_ID);

    expect(result).toEqual({
      ok: false,
      code: "ROLE_IN_USE",
      assignedCount: 3,
    });
    expect(mockDeleteMappingsForRole).not.toHaveBeenCalled();
    expect(mockDeleteRoleById).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("deletes the role and writes a ROLE_DELETED audit event with no mappings", async () => {
    mockFindRoleById.mockResolvedValue(CUSTOM_ROLE);
    mockCountByRoleId.mockResolvedValue(0);
    mockFindMappingsForRole.mockResolvedValue([]);

    const result = await deleteRole(input, ACTOR_ID);

    expect(mockDeleteMappingsForRole).toHaveBeenCalledWith(
      expect.anything(),
      "role-1",
    );
    expect(mockDeleteRoleById).toHaveBeenCalledWith(
      expect.anything(),
      "role-1",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(expect.anything(), {
      eventType: "ROLE_DELETED",
      actorUserId: ACTOR_ID,
      targetEntity: "ROLES",
      targetId: "role-1",
      beforeData: {
        roleName: "Finance",
        roleDescr: "Finance team",
        permissionMappings: [],
      },
      afterData: null,
    });
    expect(result).toEqual({ ok: true });
  });

  it("includes existing permission mappings in the before-snapshot", async () => {
    mockFindRoleById.mockResolvedValue(CUSTOM_ROLE);
    mockCountByRoleId.mockResolvedValue(0);
    mockFindMappingsForRole.mockResolvedValue([
      { permissionName: "users", permissionType: "READ" },
      { permissionName: "roles", permissionType: "EDIT" },
    ]);

    await deleteRole(input, ACTOR_ID);

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        beforeData: expect.objectContaining({
          permissionMappings: [
            { permissionName: "users", permissionType: "READ" },
            { permissionName: "roles", permissionType: "EDIT" },
          ],
        }),
      }),
    );
  });

  it("deletes mappings before deleting the role row (FK order)", async () => {
    mockFindRoleById.mockResolvedValue(CUSTOM_ROLE);
    mockCountByRoleId.mockResolvedValue(0);
    mockFindMappingsForRole.mockResolvedValue([]);

    const callOrder: string[] = [];
    mockDeleteMappingsForRole.mockImplementation(async () => {
      callOrder.push("deleteMappingsForRole");
    });
    mockDeleteRoleById.mockImplementation(async () => {
      callOrder.push("deleteRoleById");
    });

    await deleteRole(input, ACTOR_ID);

    expect(callOrder).toEqual(["deleteMappingsForRole", "deleteRoleById"]);
  });

  it("propagates the error and writes no audit event when deleteRoleById throws", async () => {
    mockFindRoleById.mockResolvedValue(CUSTOM_ROLE);
    mockCountByRoleId.mockResolvedValue(0);
    mockFindMappingsForRole.mockResolvedValue([]);
    mockDeleteRoleById.mockRejectedValue(new Error("db exploded"));

    await expect(deleteRole(input, ACTOR_ID)).rejects.toThrow("db exploded");
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});
