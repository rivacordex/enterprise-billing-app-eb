import { randomUUID } from "node:crypto";

import { and, asc, count, eq, ne, notInArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import { account, appuser, type AppUser } from "@/db/schema/identity";
import { roleAssign } from "@/db/schema/role-assign";
import { roles } from "@/db/schema/roles";
import type { AuthMethod } from "@/types/rbac";

export async function findUserById(
  db: Database,
  id: string,
): Promise<AppUser | null> {
  const [row] = await db
    .select()
    .from(appuser)
    .where(eq(appuser.id, id))
    .limit(1);
  return row ?? null;
}

export async function findUserByEmail(
  db: Database,
  email: string,
): Promise<AppUser | null> {
  const [row] = await db
    .select()
    .from(appuser)
    .where(eq(appuser.userEmail, email))
    .limit(1);
  return row ?? null;
}

export async function updateLastLogin(
  db: Database,
  userId: string,
  loginDatetime: Date,
): Promise<void> {
  await db
    .update(appuser)
    .set({ lastLoginDatetime: loginDatetime })
    .where(eq(appuser.id, userId));
}

// Updates the user's `credential` account password hash (um09-spec
// §9.3.1) — used by the forced first-login / admin-reset password flow.
// Throws if no row is updated (should never occur for a LOCAL user).
export async function updateAccountPassword(
  tx: Database,
  userId: string,
  passwordHash: string,
): Promise<void> {
  const result = await tx
    .update(account)
    .set({ password: passwordHash, lastModifiedDatetime: new Date() })
    .where(
      and(eq(account.userId, userId), eq(account.providerId, "credential")),
    )
    .returning({ id: account.id });

  if (result.length === 0) {
    throw new Error(
      `updateAccountPassword: no credential account found for user ${userId}`,
    );
  }
}

// Clears the forced-password-change flag (um09-spec §9.3.2).
export async function clearForcePasswordChange(
  tx: Database,
  userId: string,
): Promise<void> {
  await tx
    .update(appuser)
    .set({ forcePasswordChange: false, lastModifiedDatetime: new Date() })
    .where(eq(appuser.id, userId));
}

// Flips a PENDING user to ACTIVE (um09-spec §9.3.3) — a no-op for a user
// already ACTIVE (the WHERE clause matches zero rows). The return value
// tells the caller whether `USER_FIRST_LOGIN` should be written.
export async function activateUser(
  tx: Database,
  userId: string,
): Promise<{ wasActivated: boolean }> {
  const result = await tx
    .update(appuser)
    .set({ status: "ACTIVE", lastModifiedDatetime: new Date() })
    .where(and(eq(appuser.id, userId), eq(appuser.status, "PENDING")))
    .returning({ id: appuser.id });

  return { wasActivated: result.length > 0 };
}

// Inserts the new `core.appuser` row for the create-user flow (um08-spec
// §8.3.1). The id is generated here, not by the caller, matching how the
// seeded admin's id is produced.
export async function insertAppUser(
  tx: Database,
  data: {
    userName: string;
    userEmail: string;
    userPhonenum: string | null;
    authMethod: AuthMethod;
  },
): Promise<{ userId: string }> {
  const userId = randomUUID();
  const now = new Date();

  await tx.insert(appuser).values({
    id: userId,
    userName: data.userName,
    userEmail: data.userEmail,
    userPhonenum: data.userPhonenum,
    emailVerified: true,
    authMethod: data.authMethod,
    status: "PENDING",
    forcePasswordChange: data.authMethod === "LOCAL",
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginDatetime: null,
    createdDatetime: now,
    lastModifiedDatetime: now,
  });

  return { userId };
}

// Inserts the `core.account` row for a LOCAL user's temp password
// (um08-spec §8.3.2). Never called for SSO users — Better-Auth creates
// their `account` row on first Entra login.
export async function insertCredentialAccount(
  tx: Database,
  userId: string,
  passwordHash: string,
): Promise<void> {
  const now = new Date();

  await tx.insert(account).values({
    id: randomUUID(),
    userId,
    providerId: "credential",
    providerAccountId: userId,
    password: passwordHash,
    createdDatetime: now,
    lastModifiedDatetime: now,
  });
}

// Sets the `auth_method` plus its dependent flags for the auth-method
// switch (um16-spec §16.2.1). SSO → LOCAL passes `forcePasswordChange: true`
// (the temp password must be changed on next sign-in); LOCAL → SSO passes
// `false` and clears any lockout state (`failedLoginCount: 0`,
// `lockedUntil: null`). Runs inside the switch transaction.
export async function updateAuthMethodFields(
  tx: Database,
  userId: string,
  fields: {
    authMethod: AuthMethod;
    forcePasswordChange: boolean;
    failedLoginCount: number;
    lockedUntil: Date | null;
  },
): Promise<void> {
  await tx
    .update(appuser)
    .set({
      authMethod: fields.authMethod,
      forcePasswordChange: fields.forcePasswordChange,
      failedLoginCount: fields.failedLoginCount,
      lockedUntil: fields.lockedUntil,
      lastModifiedDatetime: new Date(),
    })
    .where(eq(appuser.id, userId));
}

// Deletes the user's `account` row for a single provider (um16-spec
// §16.2.2). A no-op when no matching row exists (e.g. SSO → LOCAL on a
// PENDING user who never signed in via Entra and so has no `'microsoft'`
// row). The switch caller picks the provider per direction: `'microsoft'`
// for SSO → LOCAL, `'credential'` for LOCAL → SSO.
export async function deleteAccountByProvider(
  tx: Database,
  userId: string,
  providerId: "credential" | "microsoft",
): Promise<void> {
  await tx
    .delete(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, providerId)));
}

// Updates a user's editable name/phone fields (um11-spec §11.2). Does not
// return the updated row — the service reads the before-snapshot via
// `findUserById` before opening the transaction this runs inside of.
export async function updateUserNamePhone(
  tx: Database,
  userId: string,
  data: { userName: string; userPhonenum: string | null },
): Promise<void> {
  await tx
    .update(appuser)
    .set({
      userName: data.userName,
      userPhonenum: data.userPhonenum,
      lastModifiedDatetime: new Date(),
    })
    .where(eq(appuser.id, userId));
}

// Sets ACTIVE/DISABLED/DELETED status for the disable/enable (um13-spec
// §13.2.1) and tombstone-delete (um17-spec §17.2.1) flows. Does not return
// the updated row — the service reads the before-snapshot via `findUserById`
// before opening the transaction this runs inside of. The `'DELETED'` value
// is the only widening for um17; the `UPDATE` itself is unchanged and the
// `appuser_status_check` CHECK already permits it (um02).
export async function setUserStatus(
  tx: Database,
  userId: string,
  status: "ACTIVE" | "DISABLED" | "DELETED",
): Promise<void> {
  await tx
    .update(appuser)
    .set({ status, lastModifiedDatetime: new Date() })
    .where(eq(appuser.id, userId));
}

// Deletes every `role_assign` row for a user and returns how many were
// removed (um17-spec §17.2.2). Used by the tombstone flow to strip all role
// grants in the same transaction as the status change. Zero rows is not an
// error — a user with no roles at delete time is valid.
export async function removeUserRoleAssignments(
  tx: Database,
  userId: string,
): Promise<number> {
  const result = await tx
    .delete(roleAssign)
    .where(eq(roleAssign.refUserId, userId))
    .returning({ id: roleAssign.roleAssignId });
  return result.length;
}

// Deletes every `account` row for a user (um17-spec §17.2.3) — both the
// `'credential'` (password hash) and `'microsoft'` (Entra OID) rows if
// present, releasing the Entra identity for reuse. A no-op when no rows
// exist (e.g. a PENDING user with no credential and no SSO link). Intentional
// direct deletion of a Better-Auth-managed table: the user is being made
// permanently inactive and their credentials no longer serve any purpose.
export async function deleteAllUserAccounts(
  tx: Database,
  userId: string,
): Promise<void> {
  await tx.delete(account).where(eq(account.userId, userId));
}

// Returns the role names currently assigned to a user (um17-spec §17.2.4).
// Read-only — the tombstone service calls it before the transaction opens to
// build the `USER_DELETED` before-snapshot. Returns an empty array when the
// user has no assignments.
export async function getUserRoleNames(
  db: Database,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ roleName: roles.roleName })
    .from(roleAssign)
    .innerJoin(roles, eq(roles.roleId, roleAssign.refRoleId))
    .where(eq(roleAssign.refUserId, userId));
  return rows.map((r) => r.roleName);
}

// Sets the forced-password-change flag for the admin-reset flow (um14-spec
// §14.2.1) — the symmetric counterpart to um09's `clearForcePasswordChange`.
// Idempotent: setting it on a user where it's already TRUE succeeds without
// error.
export async function setForcePasswordChange(
  tx: Database,
  userId: string,
): Promise<void> {
  await tx
    .update(appuser)
    .set({ forcePasswordChange: true, lastModifiedDatetime: new Date() })
    .where(eq(appuser.id, userId));
}

// Run before the disable transaction opens (um13-spec §13.2.3, Invariant
// #13). Counts ADMIN users who would still be sign-in-capable (ACTIVE or
// PENDING) if `userId` were disabled — unlike um12's
// `roleAssignRepository.countNonDeletedUsersWithRole` (which treats DISABLED
// as still ADMIN-*capable* for the revoke-role guard), a DISABLED admin
// cannot sign in, so this disable guard excludes DISABLED too.
export async function countRemainingAdmins(
  db: Database,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(appuser)
    .innerJoin(roleAssign, eq(roleAssign.refUserId, appuser.id))
    .innerJoin(roles, eq(roles.roleId, roleAssign.refRoleId))
    .where(
      and(
        eq(roles.roleName, "ADMIN"),
        notInArray(appuser.status, ["DISABLED", "DELETED"]),
        ne(appuser.id, userId),
      ),
    );
  return row?.count ?? 0;
}

// Short-circuits the more expensive `countRemainingAdmins` query for
// non-ADMIN users (um13-spec §13.2.4).
export async function userHasAdminRole(
  db: Database,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ roleId: roles.roleId })
    .from(roleAssign)
    .innerJoin(roles, eq(roles.roleId, roleAssign.refRoleId))
    .where(and(eq(roleAssign.refUserId, userId), eq(roles.roleName, "ADMIN")))
    .limit(1);
  return rows.length > 0;
}

// One raw row per `core.role_assign` match (or one null-role row for a user
// with no assignments) — the LEFT JOIN fan-out aggregated below
// (um07-spec §7.2.1). Not exported: callers only ever see the aggregated
// shape.
type RawUserRoleRow = {
  userId: string;
  userName: string;
  userEmail: string;
  authMethod: string;
  status: string;
  lockedUntil: Date | null;
  lastLoginDatetime: Date | null;
  roleId: string | null;
  roleName: string | null;
};

type UserWithRolesRow = {
  userId: string;
  userName: string;
  userEmail: string;
  authMethod: string;
  status: string;
  lockedUntil: Date | null;
  lastLoginDatetime: Date | null;
  roles: Array<{ roleId: string; roleName: string }>;
};

export async function findAllWithRoles(
  db: Database,
): Promise<UserWithRolesRow[]> {
  const rows: RawUserRoleRow[] = await db
    .select({
      userId: appuser.id,
      userName: appuser.userName,
      userEmail: appuser.userEmail,
      authMethod: appuser.authMethod,
      status: appuser.status,
      lockedUntil: appuser.lockedUntil,
      lastLoginDatetime: appuser.lastLoginDatetime,
      roleId: roles.roleId,
      roleName: roles.roleName,
    })
    .from(appuser)
    .leftJoin(roleAssign, eq(roleAssign.refUserId, appuser.id))
    .leftJoin(roles, eq(roles.roleId, roleAssign.refRoleId))
    .orderBy(asc(appuser.userName));

  const byUserId = new Map<string, UserWithRolesRow>();
  for (const row of rows) {
    let user = byUserId.get(row.userId);
    if (!user) {
      user = {
        userId: row.userId,
        userName: row.userName,
        userEmail: row.userEmail,
        authMethod: row.authMethod,
        status: row.status,
        lockedUntil: row.lockedUntil,
        lastLoginDatetime: row.lastLoginDatetime,
        roles: [],
      };
      byUserId.set(row.userId, user);
    }
    if (row.roleId !== null && row.roleName !== null) {
      user.roles.push({ roleId: row.roleId, roleName: row.roleName });
    }
  }

  return [...byUserId.values()];
}

type RawUserRoleDetailRow = RawUserRoleRow & {
  userPhonenum: string | null;
  createdDatetime: Date;
  lastModifiedDatetime: Date;
  assignedBy: string | null;
};

type UserWithRolesDetailRow = Omit<UserWithRolesRow, "roles"> & {
  userPhonenum: string | null;
  createdDatetime: Date;
  lastModifiedDatetime: Date;
  roles: Array<{ roleId: string; roleName: string; assignedBy: string | null }>;
};

export async function findByIdWithRoles(
  db: Database,
  userId: string,
): Promise<UserWithRolesDetailRow | null> {
  const rows: RawUserRoleDetailRow[] = await db
    .select({
      userId: appuser.id,
      userName: appuser.userName,
      userEmail: appuser.userEmail,
      userPhonenum: appuser.userPhonenum,
      authMethod: appuser.authMethod,
      status: appuser.status,
      lockedUntil: appuser.lockedUntil,
      lastLoginDatetime: appuser.lastLoginDatetime,
      createdDatetime: appuser.createdDatetime,
      lastModifiedDatetime: appuser.lastModifiedDatetime,
      roleId: roles.roleId,
      roleName: roles.roleName,
      assignedBy: roleAssign.assignedBy,
    })
    .from(appuser)
    .leftJoin(roleAssign, eq(roleAssign.refUserId, appuser.id))
    .leftJoin(roles, eq(roles.roleId, roleAssign.refRoleId))
    .where(eq(appuser.id, userId));

  const [first, ...rest] = rows;
  if (!first) return null;

  const result: UserWithRolesDetailRow = {
    userId: first.userId,
    userName: first.userName,
    userEmail: first.userEmail,
    userPhonenum: first.userPhonenum,
    authMethod: first.authMethod,
    status: first.status,
    lockedUntil: first.lockedUntil,
    lastLoginDatetime: first.lastLoginDatetime,
    createdDatetime: first.createdDatetime,
    lastModifiedDatetime: first.lastModifiedDatetime,
    roles: [],
  };

  for (const row of [first, ...rest]) {
    if (row.roleId !== null && row.roleName !== null) {
      result.roles.push({
        roleId: row.roleId,
        roleName: row.roleName,
        assignedBy: row.assignedBy,
      });
    }
  }

  return result;
}
