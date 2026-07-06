import type { PermissionName, PermissionType, Role } from "@/types/rbac";

export type { Role, RoleInsert } from "@/types/rbac";

// One entry per known permission (um18-spec §18.1) — `assignedLevel: null`
// means the role has no `role_permission_assign` row for that permission.
export interface RolePermissionMapping {
  permissionName: PermissionName;
  assignedLevel: PermissionType | null;
}

// `mappings` always has exactly `PERMISSION_NAMES.length` entries, in
// `PERMISSION_NAMES` order — the service is responsible for building this
// full array so components never need to fill gaps themselves.
export type RoleWithMappings = Role & {
  mappings: RolePermissionMapping[];
};

// The only place the permission display-label map is defined (um18-spec
// §18.1) — components import this, no raw string mapping elsewhere.
export const PERMISSION_DISPLAY_NAMES: Record<PermissionName, string> = {
  users: "Users",
  roles: "Roles",
  system_config: "System Config",
  audit_log: "Audit Log",
  products: "Products",
} as const;
