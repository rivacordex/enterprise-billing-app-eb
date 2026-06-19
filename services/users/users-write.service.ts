import { db } from "@/db/client";
import {
  countRemainingAdmins,
  findUserByEmail,
  findUserById,
  insertAppUser,
  insertCredentialAccount,
  setUserStatus,
  updateUserNamePhone,
  userHasAdminRole,
} from "@/db/repositories/appuser.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { roleAssignRepository } from "@/db/repositories/role-assign.repository";
import { rolesRepository } from "@/db/repositories/roles.repository";
import { deleteByUserId } from "@/db/repositories/session.repository";
import { generateTempPassword, hashTempPassword } from "@/lib/temp-password";
import type { AssignRoleInput } from "@/validation/assign-role.schema";
import type { CreateUserInput } from "@/validation/create-user.schema";
import type { DisableUserInput } from "@/validation/disable-user.schema";
import type { EnableUserInput } from "@/validation/enable-user.schema";
import type { RevokeRoleInput } from "@/validation/revoke-role.schema";
import type { UpdateUserDetailsInput } from "@/validation/update-user-details.schema";

export type CreateUserResult =
  | { ok: true; userId: string; tempPassword: string | null }
  | { ok: false; code: "EMAIL_CONFLICT" };

// um08-spec §8.4. `findUserByEmail` (um04) returns a user of any status —
// DELETED users are excluded here, not in the repository, since the
// repository's existing callers (the sign-in lockout flow) need every
// status to make their own decisions.
export async function createUser(
  input: CreateUserInput,
  actorId: string,
): Promise<CreateUserResult> {
  const existing = await findUserByEmail(db, input.userEmail);
  if (existing && existing.status !== "DELETED") {
    return { ok: false, code: "EMAIL_CONFLICT" };
  }

  let tempPassword: string | null = null;
  let passwordHash: string | null = null;
  if (input.authMethod === "LOCAL") {
    tempPassword = generateTempPassword();
    passwordHash = await hashTempPassword(tempPassword);
  }

  const userId = await db.transaction(async (tx) => {
    const { userId } = await insertAppUser(tx, {
      userName: input.userName,
      userEmail: input.userEmail,
      userPhonenum: input.userPhonenum,
      authMethod: input.authMethod,
    });

    if (input.authMethod === "LOCAL" && passwordHash !== null) {
      await insertCredentialAccount(tx, userId, passwordHash);
    }

    if (input.roleIds.length > 0) {
      await roleAssignRepository.insertRoleAssignments(
        tx,
        userId,
        input.roleIds,
        actorId,
      );
    }

    await insertAuditEvent(tx, {
      eventType: "USER_CREATED",
      actorUserId: actorId,
      targetEntity: "APPUSER",
      targetId: userId,
      beforeData: null,
      afterData: {
        userName: input.userName,
        userEmail: input.userEmail,
        authMethod: input.authMethod,
        status: "PENDING",
        roles: input.roleIds,
      },
    });

    return userId;
  });

  return { ok: true, userId, tempPassword };
}

export type UpdateUserDetailsResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" };

// um11-spec §11.3. Reads the before-snapshot ahead of the transaction so
// `before_data` on the `USER_UPDATED` audit row reflects the values as they
// stood immediately before the write, not after.
export async function updateUserDetails(
  input: UpdateUserDetailsInput,
  actorId: string,
): Promise<UpdateUserDetailsResult> {
  const existingUser = await findUserById(db, input.userId);
  if (!existingUser) {
    return { ok: false, code: "USER_NOT_FOUND" };
  }

  const before = {
    userName: existingUser.userName,
    userPhonenum: existingUser.userPhonenum,
  };

  await db.transaction(async (tx) => {
    await updateUserNamePhone(tx, input.userId, {
      userName: input.userName,
      userPhonenum: input.userPhonenum,
    });

    await insertAuditEvent(tx, {
      eventType: "USER_UPDATED",
      actorUserId: actorId,
      targetEntity: "APPUSER",
      targetId: input.userId,
      beforeData: before,
      afterData: {
        userName: input.userName,
        userPhonenum: input.userPhonenum,
      },
    });
  });

  return { ok: true };
}

export type AssignRoleResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "ALREADY_ASSIGNED" }
  | { ok: false; code: "CANNOT_ASSIGN_TO_DELETED_USER" };

// um12-spec §12.6.
export async function assignRole(
  input: AssignRoleInput,
  actorId: string,
): Promise<AssignRoleResult> {
  const user = await findUserById(db, input.userId);
  if (!user) {
    return { ok: false, code: "USER_NOT_FOUND" };
  }
  if (user.status === "DELETED") {
    return { ok: false, code: "CANNOT_ASSIGN_TO_DELETED_USER" };
  }

  const role = await rolesRepository.findRoleById(db, input.roleId);
  if (!role) {
    return { ok: false, code: "ROLE_NOT_FOUND" };
  }

  const existing = await roleAssignRepository.findByUserIdAndRoleId(
    db,
    input.userId,
    input.roleId,
  );
  if (existing) {
    return { ok: false, code: "ALREADY_ASSIGNED" };
  }

  await db.transaction(async (tx) => {
    const newRow = await roleAssignRepository.insertRoleAssign(tx, {
      refUserId: input.userId,
      refRoleId: input.roleId,
      assignedBy: actorId,
    });

    await insertAuditEvent(tx, {
      eventType: "ROLE_ASSIGNED",
      actorUserId: actorId,
      targetEntity: "ROLE_ASSIGN",
      targetId: newRow.roleAssignId,
      beforeData: null,
      afterData: {
        userId: input.userId,
        roleId: input.roleId,
        roleName: role.roleName,
        assignedBy: actorId,
      },
    });
  });

  return { ok: true };
}

export type RevokeRoleResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "ASSIGNMENT_NOT_FOUND" }
  | { ok: false; code: "LAST_ADMIN_ROLE" };

// um12-spec §12.7. Invariant #13 (last ADMIN-capable account never
// removed): a revoke of the ADMIN role is blocked while it is the only
// non-DELETED user holding it.
export async function revokeRole(
  input: RevokeRoleInput,
  actorId: string,
): Promise<RevokeRoleResult> {
  const user = await findUserById(db, input.userId);
  if (!user) {
    return { ok: false, code: "USER_NOT_FOUND" };
  }

  const role = await rolesRepository.findRoleById(db, input.roleId);
  if (!role) {
    return { ok: false, code: "ROLE_NOT_FOUND" };
  }

  const existing = await roleAssignRepository.findByUserIdAndRoleId(
    db,
    input.userId,
    input.roleId,
  );
  if (!existing) {
    return { ok: false, code: "ASSIGNMENT_NOT_FOUND" };
  }

  if (role.roleName === "ADMIN") {
    const adminCount = await roleAssignRepository.countNonDeletedUsersWithRole(
      db,
      input.roleId,
    );
    if (adminCount <= 1) {
      return { ok: false, code: "LAST_ADMIN_ROLE" };
    }
  }

  await db.transaction(async (tx) => {
    const deleted = await roleAssignRepository.deleteRoleAssign(tx, {
      refUserId: input.userId,
      refRoleId: input.roleId,
    });
    if (!deleted) {
      throw new Error(
        `revokeRole: role assignment disappeared mid-transaction for user ${input.userId}, role ${input.roleId}`,
      );
    }

    await insertAuditEvent(tx, {
      eventType: "ROLE_REVOKED",
      actorUserId: actorId,
      targetEntity: "ROLE_ASSIGN",
      targetId: existing.roleAssignId,
      beforeData: {
        userId: input.userId,
        roleId: input.roleId,
        roleName: role.roleName,
        assignedBy: existing.assignedBy,
      },
      afterData: null,
    });
  });

  return { ok: true };
}

export type DisableUserResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "LAST_ADMIN" }
  | { ok: false; code: "INVALID_STATE" };

// um13-spec §13.3.1. Disabling kills the target's sessions inside the same
// transaction as the status update so their next request fails at once
// (Invariant #8). The last-admin guard (Invariant #13) runs ahead of the
// transaction.
export async function disableUser(
  input: DisableUserInput,
  actorId: string,
): Promise<DisableUserResult> {
  const existingUser = await findUserById(db, input.userId);
  if (!existingUser) {
    return { ok: false, code: "USER_NOT_FOUND" };
  }
  if (existingUser.status === "DISABLED" || existingUser.status === "DELETED") {
    return { ok: false, code: "INVALID_STATE" };
  }

  if (await userHasAdminRole(db, input.userId)) {
    const remainingAdmins = await countRemainingAdmins(db, input.userId);
    if (remainingAdmins === 0) {
      return { ok: false, code: "LAST_ADMIN" };
    }
  }

  const before = { status: existingUser.status };

  await db.transaction(async (tx) => {
    await setUserStatus(tx, input.userId, "DISABLED");
    await deleteByUserId(tx, input.userId);

    await insertAuditEvent(tx, {
      eventType: "USER_DISABLED",
      actorUserId: actorId,
      targetEntity: "APPUSER",
      targetId: input.userId,
      beforeData: before,
      afterData: { status: "DISABLED" },
    });
  });

  return { ok: true };
}

export type EnableUserResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "INVALID_STATE" };

// um13-spec §13.3.2. Only DISABLED users can be enabled — PENDING users
// re-activate via the normal first-login flow (um09), DELETED users cannot
// be re-enabled. No session creation here; the user authenticates normally
// on their next sign-in.
export async function enableUser(
  input: EnableUserInput,
  actorId: string,
): Promise<EnableUserResult> {
  const existingUser = await findUserById(db, input.userId);
  if (!existingUser) {
    return { ok: false, code: "USER_NOT_FOUND" };
  }
  if (existingUser.status !== "DISABLED") {
    return { ok: false, code: "INVALID_STATE" };
  }

  const before = { status: "DISABLED" };

  await db.transaction(async (tx) => {
    await setUserStatus(tx, input.userId, "ACTIVE");

    await insertAuditEvent(tx, {
      eventType: "USER_ENABLED",
      actorUserId: actorId,
      targetEntity: "APPUSER",
      targetId: input.userId,
      beforeData: before,
      afterData: { status: "ACTIVE" },
    });
  });

  return { ok: true };
}
