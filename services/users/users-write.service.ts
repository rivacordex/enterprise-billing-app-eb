import { isCurrentlyLocked } from "@/auth/lockout";
import { db } from "@/db/client";
import {
  countRemainingAdmins,
  deleteAllUserAccounts,
  deleteAccountByProvider,
  findUserByEmail,
  findUserById,
  getUserRoleNames,
  insertAppUser,
  insertCredentialAccount,
  removeUserRoleAssignments,
  setForcePasswordChange,
  setUserStatus,
  updateAccountPassword,
  updateAuthMethodFields,
  updateUserNamePhone,
  userHasAdminRole,
} from "@/db/repositories/appuser.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import {
  adminClearLockout,
  getLockoutState,
} from "@/db/repositories/lockout.repository";
import { roleAssignRepository } from "@/db/repositories/role-assign.repository";
import { rolesRepository } from "@/db/repositories/roles.repository";
import { deleteByUserId } from "@/db/repositories/session.repository";
import { generateTempPassword, hashTempPassword } from "@/lib/temp-password";
import type { AssignRoleInput } from "@/validation/assign-role.schema";
import type { CreateUserInput } from "@/validation/create-user.schema";
import type { DeleteUserInput } from "@/validation/delete-user.schema";
import type { DisableUserInput } from "@/validation/disable-user.schema";
import type { EnableUserInput } from "@/validation/enable-user.schema";
import type { ResetPasswordInput } from "@/validation/reset-password.schema";
import type { RevokeRoleInput } from "@/validation/revoke-role.schema";
import type { SwitchAuthMethodInput } from "@/validation/switch-auth-method.schema";
import type { UnlockAccountInput } from "@/validation/unlock-account.schema";
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

// Internal sentinel thrown inside `revokeRole`'s transaction to roll back
// and signal `LAST_ADMIN_ROLE` without treating it as an unexpected error.
class LastAdminRoleGuardError extends Error {}

// um12-spec §12.7. Invariant #13 (last ADMIN-capable account never
// removed): a revoke of the ADMIN role is blocked while it is the only
// non-DELETED user holding it. The count re-check runs inside the same
// transaction as the delete (using `tx`, not `db`) so a concurrent revoke
// can't both pass the pre-check and remove the last admin.
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

  try {
    await db.transaction(async (tx) => {
      if (role.roleName === "ADMIN") {
        const adminCount =
          await roleAssignRepository.countNonDeletedUsersWithRole(
            tx,
            input.roleId,
          );
        if (adminCount <= 1) {
          throw new LastAdminRoleGuardError();
        }
      }

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
  } catch (error) {
    if (error instanceof LastAdminRoleGuardError) {
      return { ok: false, code: "LAST_ADMIN_ROLE" };
    }
    throw error;
  }

  return { ok: true };
}

export type DisableUserResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "LAST_ADMIN" }
  | { ok: false; code: "INVALID_STATE" };

// Internal sentinel thrown inside `disableUser`'s transaction to roll back
// and signal `LAST_ADMIN` without treating it as an unexpected error.
class LastAdminGuardError extends Error {}

// um13-spec §13.3.1. Disabling kills the target's sessions inside the same
// transaction as the status update so their next request fails at once
// (Invariant #8). The last-admin guard (Invariant #13) re-checks inside
// that same transaction (using `tx`, not `db`) so a concurrent disable
// can't both pass the pre-check and remove the last sign-in-capable admin.
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

  const before = { status: existingUser.status };

  try {
    await db.transaction(async (tx) => {
      if (await userHasAdminRole(tx, input.userId)) {
        const remainingAdmins = await countRemainingAdmins(tx, input.userId);
        if (remainingAdmins === 0) {
          throw new LastAdminGuardError();
        }
      }

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
  } catch (error) {
    if (error instanceof LastAdminGuardError) {
      return { ok: false, code: "LAST_ADMIN" };
    }
    throw error;
  }

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

export type ResetLocalPasswordResult =
  | { ok: true; tempPassword: string }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "NOT_LOCAL_USER" }
  | { ok: false; code: "INVALID_STATE" };

// um14-spec §14.3. Generates a new one-time temp password, hashes it, and
// atomically writes the hash + forces a password change + revokes every
// active session (Invariant #8) + writes `USER_PASSWORD_RESET`. The
// plaintext only ever lives in this function's local scope and the success
// return value — never logged, persisted, or included in the audit event
// (Invariant #1).
export async function resetLocalPassword(
  input: ResetPasswordInput,
  actorId: string,
): Promise<ResetLocalPasswordResult> {
  const existingUser = await findUserById(db, input.userId);
  if (!existingUser) {
    return { ok: false, code: "USER_NOT_FOUND" };
  }
  if (existingUser.authMethod !== "LOCAL") {
    return { ok: false, code: "NOT_LOCAL_USER" };
  }
  if (existingUser.status === "DELETED") {
    return { ok: false, code: "INVALID_STATE" };
  }

  const tempPasswordPlaintext = generateTempPassword();
  const passwordHash = await hashTempPassword(tempPasswordPlaintext);

  const before = { forcePasswordChange: existingUser.forcePasswordChange };

  await db.transaction(async (tx) => {
    await updateAccountPassword(tx, input.userId, passwordHash);
    await setForcePasswordChange(tx, input.userId);
    await deleteByUserId(tx, input.userId);

    await insertAuditEvent(tx, {
      eventType: "USER_PASSWORD_RESET",
      actorUserId: actorId,
      targetEntity: "APPUSER",
      targetId: input.userId,
      beforeData: before,
      afterData: { forcePasswordChange: true },
    });
  });

  return { ok: true, tempPassword: tempPasswordPlaintext };
}

export type UnlockAccountResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "NOT_LOCKED" }
  | { ok: false; code: "INVALID_STATE" };

// um15-spec §15.3. The lock-state re-check (`isCurrentlyLocked`, not an
// inline comparison) runs immediately before the transaction so a lock that
// expired between the page render and the action firing is reported as
// NOT_LOCKED rather than silently "succeeding" against an already-clear
// account.
export async function unlockAccount(
  input: UnlockAccountInput,
  actorId: string,
): Promise<UnlockAccountResult> {
  const existingUser = await findUserById(db, input.userId);
  if (!existingUser) {
    return { ok: false, code: "USER_NOT_FOUND" };
  }
  if (existingUser.status === "DELETED") {
    return { ok: false, code: "INVALID_STATE" };
  }

  const lockState = await getLockoutState(db, input.userId);
  if (!isCurrentlyLocked(lockState)) {
    return { ok: false, code: "NOT_LOCKED" };
  }

  const before = {
    failedLoginCount: lockState.failedLoginCount,
    lockedUntil: lockState.lockedUntil?.toISOString() ?? null,
  };

  await db.transaction(async (tx) => {
    await adminClearLockout(tx, input.userId);

    await insertAuditEvent(tx, {
      eventType: "USER_UNLOCKED",
      actorUserId: actorId,
      targetEntity: "APPUSER",
      targetId: input.userId,
      beforeData: before,
      afterData: { failedLoginCount: 0, lockedUntil: null },
    });
  });

  return { ok: true };
}

export type SwitchAuthMethodResult =
  | { ok: true; newAuthMethod: "LOCAL"; tempPassword: string }
  | { ok: true; newAuthMethod: "SSO" }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "USER_DELETED" }
  | { ok: false; code: "ALREADY_METHOD" };

// um16-spec §16.3. Switches a user's `auth_method` between SSO and LOCAL,
// enforcing the two methods as mutually exclusive (Invariant #9) and
// revoking every active session in the same transaction (Invariant #8).
//
// SSO → LOCAL generates a one-time temp password (the plaintext only ever
// lives in this function's scope and the success return value — never
// logged, persisted, or placed in the audit event, Invariant #1), forces a
// password change, and swaps the `'microsoft'` account row for a fresh
// `'credential'` one. LOCAL → SSO removes the `'credential'` row and clears
// any lockout state; the `'microsoft'` row is (re)created by um10's SSO
// first-sign-in linking flow on the user's next Entra sign-in.
export async function switchAuthMethod(
  input: SwitchAuthMethodInput,
  actorId: string,
): Promise<SwitchAuthMethodResult> {
  const existingUser = await findUserById(db, input.userId);
  if (!existingUser) {
    return { ok: false, code: "USER_NOT_FOUND" };
  }
  if (existingUser.status === "DELETED") {
    return { ok: false, code: "USER_DELETED" };
  }
  if (existingUser.authMethod === input.newAuthMethod) {
    return { ok: false, code: "ALREADY_METHOD" };
  }

  if (input.newAuthMethod === "LOCAL") {
    const tempPasswordPlaintext = generateTempPassword();
    const passwordHash = await hashTempPassword(tempPasswordPlaintext);

    await db.transaction(async (tx) => {
      await updateAuthMethodFields(tx, input.userId, {
        authMethod: "LOCAL",
        forcePasswordChange: true,
        failedLoginCount: 0,
        lockedUntil: null,
      });
      await deleteAccountByProvider(tx, input.userId, "microsoft");
      await insertCredentialAccount(tx, input.userId, passwordHash);
      const revokedCount = await deleteByUserId(tx, input.userId);

      await insertAuditEvent(tx, {
        eventType: "USER_AUTH_METHOD_CHANGED",
        actorUserId: actorId,
        targetEntity: "APPUSER",
        targetId: input.userId,
        beforeData: { authMethod: "SSO" },
        afterData: { authMethod: "LOCAL", sessionsRevoked: revokedCount },
      });
    });

    return {
      ok: true,
      newAuthMethod: "LOCAL",
      tempPassword: tempPasswordPlaintext,
    };
  }

  await db.transaction(async (tx) => {
    await updateAuthMethodFields(tx, input.userId, {
      authMethod: "SSO",
      forcePasswordChange: false,
      failedLoginCount: 0,
      lockedUntil: null,
    });
    await deleteAccountByProvider(tx, input.userId, "credential");
    const revokedCount = await deleteByUserId(tx, input.userId);

    await insertAuditEvent(tx, {
      eventType: "USER_AUTH_METHOD_CHANGED",
      actorUserId: actorId,
      targetEntity: "APPUSER",
      targetId: input.userId,
      beforeData: { authMethod: "LOCAL" },
      afterData: { authMethod: "SSO", sessionsRevoked: revokedCount },
    });
  });

  return { ok: true, newAuthMethod: "SSO" };
}

export type TombstoneDeleteUserResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "LAST_ADMIN" };

// um17-spec §17.3. Tombstone-deletes a user: flips `status` to DELETED,
// strips every role assignment and `account` credential row, cleans up any
// residual sessions, and writes `USER_DELETED` capturing the pre-deletion
// name, email, status, and role names — all atomically in one transaction
// (Invariant #11). The `appuser` row itself is preserved (Invariant #12, no
// physical delete); removing its `account` rows and relying on the partial
// unique index that excludes DELETED frees the email and Entra identity for
// reuse. Only a DISABLED user can be tombstoned; the last-admin guard
// (Invariant #13) is defence in depth — a DISABLED admin already implies
// another sign-in-capable admin exists (um13's disable guard enforced it).
export async function tombstoneDeleteUser(
  input: DeleteUserInput,
  actorId: string,
): Promise<TombstoneDeleteUserResult> {
  const existingUser = await findUserById(db, input.userId);
  if (!existingUser) {
    return { ok: false, code: "USER_NOT_FOUND" };
  }
  if (existingUser.status !== "DISABLED") {
    return { ok: false, code: "INVALID_STATE" };
  }

  if (await userHasAdminRole(db, input.userId)) {
    const remainingAdmins = await countRemainingAdmins(db, input.userId);
    if (remainingAdmins === 0) {
      return { ok: false, code: "LAST_ADMIN" };
    }
  }

  const roleNames = await getUserRoleNames(db, input.userId);

  const before = {
    userName: existingUser.userName,
    userEmail: existingUser.userEmail,
    status: existingUser.status,
    roles: roleNames,
  };

  await db.transaction(async (tx) => {
    await setUserStatus(tx, input.userId, "DELETED");
    await removeUserRoleAssignments(tx, input.userId);
    await deleteAllUserAccounts(tx, input.userId);
    await deleteByUserId(tx, input.userId);

    await insertAuditEvent(tx, {
      eventType: "USER_DELETED",
      actorUserId: actorId,
      targetEntity: "APPUSER",
      targetId: input.userId,
      beforeData: before,
      afterData: { status: "DELETED" },
    });
  });

  return { ok: true };
}
