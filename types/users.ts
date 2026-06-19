import type { AuthMethod, UserStatus } from "@/types/rbac";

// Shape for `UserTable` rows (um07-spec §7.1). Decoupled from the Drizzle
// row shapes on purpose — the service maps DB rows into these, so the
// table/detail components never depend on the schema directly.
export interface UserListItem {
  userId: string;
  userName: string;
  userEmail: string;
  authMethod: AuthMethod;
  status: UserStatus;
  isLocked: boolean;
  roles: Array<{ roleId: string; roleName: string }>;
  lastLoginDatetime: Date | null;
}

// Shape for the `UserDetail` panel (um07-spec §7.1).
export interface UserDetailView {
  userId: string;
  userName: string;
  userEmail: string;
  userPhonenum: string | null;
  authMethod: AuthMethod;
  status: UserStatus;
  isLocked: boolean;
  lockedUntil: Date | null;
  roles: Array<{ roleId: string; roleName: string; assignedBy: string | null }>;
  lastLoginDatetime: Date | null;
  createdDatetime: Date;
  lastModifiedDatetime: Date;
}
