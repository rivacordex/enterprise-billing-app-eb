import { db } from "@/db/client";
import {
  findAllWithRoles,
  findByIdWithRoles,
} from "@/db/repositories/appuser.repository";
import type { AuthMethod, UserStatus } from "@/types/rbac";
import type { UserDetailView, UserListItem } from "@/types/users";

function computeIsLocked(lockedUntil: Date | null): boolean {
  return lockedUntil !== null && lockedUntil > new Date();
}

// Returns every user, including DELETED — the caller (UserTable) decides
// what to display based on the "Show deleted" toggle (um07-spec §7.3).
export async function listUsers(): Promise<UserListItem[]> {
  const rows = await findAllWithRoles(db);

  return rows.map((row) => ({
    userId: row.userId,
    userName: row.userName,
    userEmail: row.userEmail,
    authMethod: row.authMethod as AuthMethod,
    status: row.status as UserStatus,
    isLocked: computeIsLocked(row.lockedUntil),
    roles: row.roles,
    lastLoginDatetime: row.lastLoginDatetime,
  }));
}

export async function getUserById(
  userId: string,
): Promise<UserDetailView | null> {
  const row = await findByIdWithRoles(db, userId);
  if (!row) return null;

  return {
    userId: row.userId,
    userName: row.userName,
    userEmail: row.userEmail,
    userPhonenum: row.userPhonenum,
    authMethod: row.authMethod as AuthMethod,
    status: row.status as UserStatus,
    isLocked: computeIsLocked(row.lockedUntil),
    lockedUntil: row.lockedUntil,
    roles: row.roles,
    lastLoginDatetime: row.lastLoginDatetime,
    createdDatetime: row.createdDatetime,
    lastModifiedDatetime: row.lastModifiedDatetime,
  };
}
