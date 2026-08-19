import type { PermissionName, PermissionType } from "@/types/rbac";

// Optional module permissions: absent for users whose roles pre-date the
// owning module (accounts — um06; ordering/inventory — pm25; bill run — bm01),
// matching the DB
// resolver behaviour (it omits any permission a user's roles hold no grant
// for). Keeping them out of the required set is also what stops a new module's
// permission from rippling `null` into every hardcoded EffectivePermissionMap
// fixture across the test suite.
type OptionalPermissionName =
  | "accounts_view"
  | "accounts_transactions"
  | "accounts_config"
  | "product_orders"
  | "product_inventory"
  | "billrun_view"
  | "billrun_operate"
  | "billrun_approve";
type CorePermissionName = Exclude<PermissionName, OptionalPermissionName>;

// Core module permissions (users, roles, etc.) are always present; optional
// module permissions (above) are present only when granted.
export type EffectivePermissionMap = Record<
  CorePermissionName,
  PermissionType | null
> &
  Partial<Record<OptionalPermissionName, PermissionType | null>>;

export const LEVEL_RANK: Record<PermissionType, number> = {
  READ: 1,
  EDIT: 2,
  DELETE: 3,
};

// The only place the numeric rank comparison is implemented (um06-spec
// Invariant #5 sibling rule for §6.2). Server-side and client-safe.
export function meetsLevel(
  effective: PermissionType | null | undefined,
  required: PermissionType,
): boolean {
  if (effective == null) return false;
  return LEVEL_RANK[effective] >= LEVEL_RANK[required];
}

// Convenience wrapper for client components — the only place the level
// comparison is allowed client-side (show/hide only, never enforcement).
export function hasLevel(
  map: EffectivePermissionMap,
  name: PermissionName,
  level: PermissionType,
): boolean {
  return meetsLevel(map[name], level);
}
