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
  ACCOUNTS_VIEW: "accounts_view",
  ACCOUNTS_TRANSACTIONS: "accounts_transactions",
  ACCOUNTS_CONFIG: "accounts_config",
  PRODUCT_ORDERS: "product_orders",
  PRODUCT_INVENTORY: "product_inventory",
} as const satisfies Record<string, PermissionName>;

export const LEVELS = {
  READ: "READ",
  EDIT: "EDIT",
  DELETE: "DELETE",
} as const satisfies Record<string, PermissionType>;
