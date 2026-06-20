import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { permissionsRepository } from "@/db/repositories/permissions.repository";
import { roleAssignRepository } from "@/db/repositories/role-assign.repository";
import { rolePermissionAssignRepository } from "@/db/repositories/role-permission-assign.repository";
import { rolesRepository } from "@/db/repositories/roles.repository";
import { isSeededRole } from "@/types/rbac";
import type { DeleteRoleInput } from "@/validation/delete-role.schema";
import type { CreateRoleInput } from "@/validation/create-role.schema";
import type { SetPermissionLevelInput } from "@/validation/set-permission-level.schema";
import type { UpdateRoleInput } from "@/validation/update-role.schema";

export type CreateRoleResult =
  | { ok: true; roleId: string }
  | { ok: false; code: "NAME_CONFLICT" };

// um19-spec §19.3. Name uniqueness is checked ahead of the transaction; the
// insert + `ROLE_CREATED` audit write run atomically inside it.
export async function createRole(
  input: CreateRoleInput,
  actorId: string,
): Promise<CreateRoleResult> {
  const existing = await rolesRepository.findRoleByName(db, input.roleName);
  if (existing) {
    return { ok: false, code: "NAME_CONFLICT" };
  }

  const roleId = await db.transaction(async (tx) => {
    const { roleId } = await rolesRepository.insertRole(tx, input);

    await insertAuditEvent(tx, {
      eventType: "ROLE_CREATED",
      actorUserId: actorId,
      targetEntity: "ROLES",
      targetId: roleId,
      beforeData: null,
      afterData: {
        roleName: input.roleName,
        roleDescr: input.roleDescr,
      },
    });

    return roleId;
  });

  return { ok: true, roleId };
}

export type UpdateRoleResult =
  | { ok: true }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "NAME_CONFLICT" };

// um19-spec §19.3. Reads the before-snapshot ahead of the transaction so
// `before_data` on the `ROLE_UPDATED` audit row reflects the values as they
// stood immediately before the write, not after. Short-circuits with no DB
// write or audit entry when the submitted values match the current role
// (prevents spurious `ROLE_UPDATED` events on a no-op save).
export async function updateRole(
  input: UpdateRoleInput,
  actorId: string,
): Promise<UpdateRoleResult> {
  const existingRole = await rolesRepository.findRoleById(db, input.roleId);
  if (!existingRole) {
    return { ok: false, code: "ROLE_NOT_FOUND" };
  }

  const conflictingRole = await rolesRepository.findRoleByName(
    db,
    input.roleName,
  );
  if (conflictingRole && conflictingRole.roleId !== input.roleId) {
    return { ok: false, code: "NAME_CONFLICT" };
  }

  const before = {
    roleName: existingRole.roleName,
    roleDescr: existingRole.roleDescr,
  };

  if (
    before.roleName === input.roleName &&
    before.roleDescr === input.roleDescr
  ) {
    return { ok: true };
  }

  await db.transaction(async (tx) => {
    await rolesRepository.updateRoleNameDescr(tx, input.roleId, {
      roleName: input.roleName,
      roleDescr: input.roleDescr,
    });

    await insertAuditEvent(tx, {
      eventType: "ROLE_UPDATED",
      actorUserId: actorId,
      targetEntity: "ROLES",
      targetId: input.roleId,
      beforeData: before,
      afterData: {
        roleName: input.roleName,
        roleDescr: input.roleDescr,
      },
    });
  });

  return { ok: true };
}

export type SetRolePermissionLevelResult =
  | { ok: true }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "AUDIT_LOG_READONLY" }
  | { ok: false; code: "PERMISSION_NOT_FOUND" };

// um20-spec §20.3. The `audit_log` READ-max guard runs first, before any DB
// reads — `audit_log` has no EDIT/DELETE level in the system. Reads the
// before-snapshot ahead of the transaction and short-circuits on a no-op
// level (prevents spurious `PERMISSION_MAPPING_CHANGED` events); the write
// + audit entry run atomically inside one `db.transaction`.
export async function setRolePermissionLevel(
  input: SetPermissionLevelInput,
  actorId: string,
): Promise<SetRolePermissionLevelResult> {
  if (
    input.permissionName === "audit_log" &&
    (input.level === "EDIT" || input.level === "DELETE")
  ) {
    return { ok: false, code: "AUDIT_LOG_READONLY" };
  }

  const role = await rolesRepository.findRoleById(db, input.roleId);
  if (!role) {
    return { ok: false, code: "ROLE_NOT_FOUND" };
  }

  const permission = await permissionsRepository.findByName(
    db,
    input.permissionName,
  );
  if (!permission) {
    return { ok: false, code: "PERMISSION_NOT_FOUND" };
  }

  await db.transaction(async (tx) => {
    const currentMappings =
      await rolePermissionAssignRepository.findMappingsForRole(
        tx,
        input.roleId,
      );
    const previousLevel =
      currentMappings.find((m) => m.permissionName === input.permissionName)
        ?.permissionType ?? null;

    if (previousLevel === input.level) {
      return;
    }

    if (input.level === null) {
      await rolePermissionAssignRepository.deleteRolePermission(tx, {
        roleId: input.roleId,
        permissionId: permission.permissionId,
      });
    } else {
      await rolePermissionAssignRepository.upsertRolePermission(tx, {
        roleId: input.roleId,
        permissionId: permission.permissionId,
        permissionType: input.level,
      });
    }

    await insertAuditEvent(tx, {
      eventType: "PERMISSION_MAPPING_CHANGED",
      actorUserId: actorId,
      targetEntity: "ROLE_PERMISSION_ASSIGN",
      targetId: input.roleId,
      beforeData: {
        roleName: role.roleName,
        permissionName: input.permissionName,
        level: previousLevel,
      },
      afterData: {
        roleName: role.roleName,
        permissionName: input.permissionName,
        level: input.level,
      },
    });
  });

  return { ok: true };
}

export type DeleteRoleResult =
  | { ok: true }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "SEEDED_ROLE" }
  | { ok: false; code: "ROLE_IN_USE"; assignedCount: number };

// um21-spec §21.4. Not-found and seeded checks run ahead of the transaction;
// the in-use check is re-run inside it (atomically with the delete) so a
// role assignment can't be inserted between the check and the delete. The
// before snapshot — role fields plus its permission mappings, captured
// before they are deleted — feeds `ROLE_DELETED`'s `before_data`. The
// mapping delete and role delete run in FK order inside the same
// transaction as the audit write so the mutation and audit entry are
// atomic (Invariant #11).
export async function deleteRole(
  input: DeleteRoleInput,
  actorId: string,
): Promise<DeleteRoleResult> {
  const role = await rolesRepository.findRoleById(db, input.roleId);
  if (!role) {
    return { ok: false, code: "ROLE_NOT_FOUND" };
  }

  if (isSeededRole(role.roleName)) {
    return { ok: false, code: "SEEDED_ROLE" };
  }

  try {
    await db.transaction(async (tx) => {
      // Re-checked inside the transaction (not just ahead of it) so a
      // concurrent role assignment can't sneak in between the count and the
      // delete below.
      const assignedCount = await roleAssignRepository.countByRoleId(
        tx,
        input.roleId,
      );
      if (assignedCount > 0) {
        throw new RoleInUseError(assignedCount);
      }

      const mappings = await rolePermissionAssignRepository.findMappingsForRole(
        tx,
        input.roleId,
      );

      await rolePermissionAssignRepository.deleteMappingsForRole(
        tx,
        input.roleId,
      );
      await rolesRepository.deleteRoleById(tx, input.roleId);

      await insertAuditEvent(tx, {
        eventType: "ROLE_DELETED",
        actorUserId: actorId,
        targetEntity: "ROLES",
        targetId: input.roleId,
        beforeData: {
          roleName: role.roleName,
          roleDescr: role.roleDescr,
          permissionMappings: mappings,
        },
        afterData: null,
      });
    });
  } catch (error) {
    if (error instanceof RoleInUseError) {
      return {
        ok: false,
        code: "ROLE_IN_USE",
        assignedCount: error.assignedCount,
      };
    }
    throw error;
  }

  return { ok: true };
}

// Carries `assignedCount` out of `db.transaction`'s callback so the
// in-use check below can run inside the transaction (atomically with the
// delete) while still surfacing a typed `ROLE_IN_USE` result.
class RoleInUseError extends Error {
  constructor(readonly assignedCount: number) {
    super("Role has active assignments");
  }
}
