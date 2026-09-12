import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { resolveEffectivePermissions } from "@/auth/resolver";
import { db } from "@/db/client";
import { findUserById } from "@/db/repositories/appuser.repository";
import { deleteByUserId } from "@/db/repositories/session.repository";
import type { AppUser } from "@/db/schema/identity";
import { meetsLevel, type EffectivePermissionMap } from "@/types/permissions";
import type { PermissionName, PermissionType } from "@/types/rbac";

// Request-scoped memo (React.cache) of the session + its APPUSER row. The `(app)`
// shell layout (via getCurrentUserIdentity) and the Homepage both resolve the
// signed-in user on a `/` render; without this they'd each run getSession +
// findUserById. `cache` dedupes them to a single fetch per RSC request and is
// a no-op/pass-through outside a request scope — it never caches across
// requests (Inv #2/#15). Not used by getActiveUser/requirePermission, which
// keep their own live reads for the enforcement path.
export const loadSessionUser = cache(
  async (): Promise<{ userId: string; user: AppUser | null } | null> => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return null;
    const user = await findUserById(db, session.user.id);
    return { userId: session.user.id, user };
  },
);

// Request-scoped memo around the single effective-permission resolver, for the
// RSC callers that resolve the SAME user more than once per render (the `/`
// shell layout for the nav + the Homepage for the directory grid). The resolver
// itself stays uncached/framework-agnostic (auth/resolver.ts) for action/route
// guards; this wrapper only dedupes within one request.
export const getEffectivePermissions = cache(resolveEffectivePermissions);

// Steps 1–4 shared by both guards below (um06-spec §6.5): resolve the
// session, confirm the user is ACTIVE (deleting stale sessions otherwise),
// and enforce a pending forced password change. Not exported — `auth/`'s
// boundary adapter for page/layout use is exactly these two guards.
async function getActiveUser(): Promise<{ userId: string; userEmail: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/login");
  }

  const user = await findUserById(db, session.user.id);
  if (!user || user.status !== "ACTIVE") {
    await deleteByUserId(db, session.user.id);
    redirect("/login");
  }

  if (user.forcePasswordChange) {
    redirect("/set-password");
  }

  return { userId: user.id, userEmail: user.userEmail };
}

// For routes that only need an ACTIVE session, no permission check —
// specifically `/no-access` itself.
export async function requireAuthenticated(): Promise<{
  userId: string;
  userEmail: string;
}> {
  return getActiveUser();
}

// um26-spec §26.1: the admin layout's sidebar footer shows the signed-in
// user's name + email. Unlike the spec's assumption, this codebase's
// `(app)/layout.tsx` runs no guard (each child page guards itself), so it
// has no resolved user. This read-only helper resolves the session-bound
// APPUSER identity for display — it returns `null` rather than redirecting so
// it can't alter the layout's redirect behavior, and living in `auth/` means
// `layout.tsx` needn't import `db/**` directly.
export async function getCurrentUserIdentity(): Promise<{
  userId: string;
  userName: string;
  userEmail: string;
} | null> {
  const resolved = await loadSessionUser();
  if (!resolved || !resolved.user) {
    return null;
  }

  return {
    userId: resolved.user.id,
    userName: resolved.user.userName,
    userEmail: resolved.user.userEmail,
  };
}

// The page/layout guard (Invariant #3, #4): called at the top of `page.tsx`
// or `layout.tsx` before rendering. Never returns a `Response` — it either
// returns the resolved context or calls `redirect()`.
export async function requirePermission(
  name: PermissionName,
  level: PermissionType,
): Promise<{
  userId: string;
  userEmail: string;
  permissionMap: EffectivePermissionMap;
}> {
  const { userId, userEmail } = await getActiveUser();

  const permissionMap = await resolveEffectivePermissions(userId);
  if (!meetsLevel(permissionMap[name], level)) {
    redirect("/no-access");
  }

  return { userId, userEmail, permissionMap };
}

// The inverse of `getActiveUser`'s `force_password_change` check (um09-spec
// §9.2): backs the `/set-password` page itself, so it must NOT redirect
// there when the flag is set — it redirects away when it ISN'T, preventing
// an already-activated user from reaching the page directly.
export async function resolveForcePasswordChangeSession(): Promise<{
  userId: string;
  userName: string;
  status: "PENDING" | "ACTIVE";
}> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/login");
  }

  const user = await findUserById(db, session.user.id);
  if (!user || user.status === "DISABLED" || user.status === "DELETED") {
    await deleteByUserId(db, session.user.id);
    redirect("/login");
  }

  if (!user.forcePasswordChange) {
    redirect("/");
  }

  return {
    userId: user.id,
    userName: user.userName,
    status: user.status as "PENDING" | "ACTIVE",
  };
}
