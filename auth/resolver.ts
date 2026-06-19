import { db } from "@/db/client";
import { roleAssignRepository } from "@/db/repositories/role-assign.repository";
import { rolePermissionAssignRepository } from "@/db/repositories/role-permission-assign.repository";
import { PERMISSION_NAMES } from "@/types/rbac";
import { LEVEL_RANK, type EffectivePermissionMap } from "@/types/permissions";

function emptyMap(): EffectivePermissionMap {
  return Object.fromEntries(
    PERMISSION_NAMES.map((name) => [name, null]),
  ) as EffectivePermissionMap;
}

// The single effective-permission resolver (Invariant #5). Pure query +
// computation: never caches, never writes, never throws a redirect.
// Framework-agnostic — no `next/*` or `app/**` import — so it can be called
// from both page guards and future action/handler guards.
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
