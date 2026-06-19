import { meetsLevel, type EffectivePermissionMap } from "@/types/permissions";
import type { PermissionName } from "@/types/rbac";

export interface RootRedirectSession {
  forcePasswordChange: boolean;
}

export interface RouteOrderEntry {
  name: PermissionName;
  route: string;
}

// Extracted from `app/page.tsx` for testability (um06-spec §6.10) — callable
// directly without a running Next.js server. The routing table itself stays
// defined in `app/page.tsx` (routing policy, not permission logic, per
// um06-spec §6.8) and is passed in here rather than duplicated.
export async function resolveRootRedirect(
  session: RootRedirectSession | null,
  permissionMap: EffectivePermissionMap | null,
  routeOrder: readonly RouteOrderEntry[],
): Promise<string> {
  if (!session) return "/login";
  if (session.forcePasswordChange) return "/set-password";

  if (permissionMap) {
    for (const { name, route } of routeOrder) {
      if (meetsLevel(permissionMap[name], "READ")) return route;
    }
  }

  return "/no-access";
}
