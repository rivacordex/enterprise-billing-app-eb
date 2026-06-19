import type { PermissionName, PermissionType } from "@/types/rbac";

// `null` = no access for that permission. Every known `PermissionName` is
// always present as a key (um06-spec §"Resolver output shape") so callers
// never need an existence check.
export type EffectivePermissionMap = Record<
  PermissionName,
  PermissionType | null
>;

export const LEVEL_RANK: Record<PermissionType, number> = {
  READ: 1,
  EDIT: 2,
  DELETE: 3,
};

// The only place the numeric rank comparison is implemented (um06-spec
// Invariant #5 sibling rule for §6.2). Server-side and client-safe.
export function meetsLevel(
  effective: PermissionType | null,
  required: PermissionType,
): boolean {
  if (effective === null) return false;
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
