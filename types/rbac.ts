export const PERMISSION_NAMES = [
  "users",
  "roles",
  "system_config",
  "audit_log",
] as const;
export type PermissionName = (typeof PERMISSION_NAMES)[number];

export const PERMISSION_TYPES = ["READ", "EDIT", "DELETE"] as const;
export type PermissionType = (typeof PERMISSION_TYPES)[number];

export const SEEDED_ROLE_NAMES = ["ADMIN", "MANAGER", "USER"] as const;
export type SeededRoleName = (typeof SEEDED_ROLE_NAMES)[number];

// Mirrors the `appuser_auth_method_check`/`appuser_status_check` CHECK
// constraints (db/schema/identity.ts) — the authoritative string sets for
// these two columns (um07-spec §7.1, code-standards §2.6).
export const AUTH_METHODS = ["SSO", "LOCAL"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const USER_STATUSES = [
  "PENDING",
  "ACTIVE",
  "DISABLED",
  "DELETED",
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export type {
  Role,
  RoleInsert,
  Permission,
  PermissionInsert,
  RoleAssign,
  RoleAssignInsert,
  RolePermissionAssign,
  RolePermissionAssignInsert,
} from "@/db/schema";

// Shape for the "Initial Roles" checklist (um08) and the "Add role" dropdown
// in `RoleAssignmentPanel` (um12-spec §12.1).
export interface RoleListItem {
  roleId: string;
  roleName: string;
  roleDescr: string | null;
}
