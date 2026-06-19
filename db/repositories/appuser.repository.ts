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

// Sets ACTIVE/DISABLED status for the disable/enable flow (um13-spec
// §13.2.1). Does not return the updated row — the service reads the
// before-snapshot via `findUserById` before opening the transaction this
// runs inside of.
export async function setUserStatus(
  tx: Database,
  userId: string,
  status: "ACTIVE" | "DISABLED",
): Promise<void> {
  await tx
    .update(appuser)
    .set({ status, lastModifiedDatetime: new Date() })
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
