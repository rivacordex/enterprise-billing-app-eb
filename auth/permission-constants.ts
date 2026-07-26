// Typed constants for permission names and levels.
// All pages and guards import from here; a typo is a compile error.

import type { PermissionName, PermissionType } from "@/types/rbac";

export const PERMISSIONS = {
  USERS: "users",
  ROLES: "roles",
  SYSTEM_CONFIG: "system_config",
  AUDIT_LOG: "audit_log",
  PRODUCTS: "products",
  CUSTOMERS: "customers",
} as const satisfies Record<string, PermissionName>;

export const LEVELS = {
  READ: "READ",
  EDIT: "EDIT",
  DELETE: "DELETE",
} as const satisfies Record<string, PermissionType>;
