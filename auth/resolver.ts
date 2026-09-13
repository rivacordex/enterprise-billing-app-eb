import { db } from "@/db/client";
import { findUserById } from "@/db/repositories/appuser.repository";
import { roleAssignRepository } from "@/db/repositories/role-assign.repository";
import { rolePermissionAssignRepository } from "@/db/repositories/role-permission-assign.repository";
import type { AppUser } from "@/db/schema/identity";
import { PERMISSION_NAMES } from "@/types/rbac";
import { LEVEL_RANK, type EffectivePermissionMap } from "@/types/permissions";

function emptyMap(): EffectivePermissionMap {
  return Object.fromEntries(
    PERMISSION_NAMES.map((name) => [name, null]),
  ) as EffectivePermissionMap;
}

// Fetches the appuser row and confirms it is ACTIVE and not time-locked. Used
// by Route Handlers that cannot call requirePermission (which redirects).
// Returns null for missing, inactive, suspended, or currently-locked users.
export async function findActiveUserById(
  userId: string,
): Promise<AppUser | null> {
  const user = await findUserById(db, userId);
  if (!user || user.status !== "ACTIVE") return null;
  if (user.lockedUntil && user.lockedUntil > new Date()) return null;
  return user;
}

// The single effective-permission resolver (Invariant #5). Pure query +
// computation: never writes, never throws a redirect, and never caches ACROSS
// requests (Inv #15/#20 — evaluated against the live principal every time).
// Framework-agnostic — no `next/*`/`react`/`app/**` import — so it can be
// called from both page guards and action/handler guards. A request-scoped
// `React.cache` wrapper (`getEffectivePermissions` in `auth/guard.ts`) dedupes
// repeat calls WITHIN one RSC render (e.g. the `/` shell layout + Homepage);
// that is per-request memoization, not a cross-request cache, so the invariant
// holds — this function stays the uncached source of truth.
export async function resolveEffectivePermissions(
  userId: string,
): Promise<EffectivePermissionMap> {
  const roleIds = await roleAssignRepository.findRoleIdsByUserId(db, userId);

  if (roleIds.length === 0) {
    return emptyMap();
  }

  const grants = await rolePermissionAssignRepository.findGrantsByRoleIds(
    db,
    roleIds,
  );

  const map = emptyMap();

  for (const name of PERMISSION_NAMES) {
    const levels = grants.filter((g) => g.permissionName === name);
    if (levels.length === 0) continue;

    let highest = levels[0]!.permissionType;
    for (const grant of levels) {
      if (LEVEL_RANK[grant.permissionType] > LEVEL_RANK[highest]) {
        highest = grant.permissionType;
      }
    }
    map[name] = highest;
  }

  return map;
}
