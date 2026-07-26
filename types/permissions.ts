import type { PermissionName, PermissionType } from "@/types/rbac";

type AccountsPermissionName =
  | "accounts_view"
  | "accounts_transactions"
  | "accounts_config";
type CorePermissionName = Exclude<PermissionName, AccountsPermissionName>;

// Core module permissions (users, roles, etc.) are always present.
// Accounts module permissions are optional — they're absent for users whose
// roles pre-date the accounts module, matching the DB resolver behaviour
// (um06-spec §"Resolver output shape").
export type EffectivePermissionMap = Record<
  CorePermissionName,
  PermissionType | null
> &
  Partial<Record<AccountsPermissionName, PermissionType | null>>;

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
