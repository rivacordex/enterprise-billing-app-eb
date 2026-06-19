import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { resolveEffectivePermissions } from "@/auth/resolver";
import { PERMISSIONS } from "@/auth/permission-constants";
import { db } from "@/db/client";
import { findUserById } from "@/db/repositories/appuser.repository";
import { deleteByUserId } from "@/db/repositories/session.repository";
import { resolveRootRedirect, type RouteOrderEntry } from "@/lib/root-redirect";

export const dynamic = "force-dynamic";

// Routing policy, not permission logic (um06-spec §6.8) — lives here, not
// in `auth/`. A new module appends a row here when it adds a page; no
// changes to `auth/` are required.
export const ROUTE_ORDER: RouteOrderEntry[] = [
  { name: PERMISSIONS.USERS, route: "/administration/users" },
  { name: PERMISSIONS.ROLES, route: "/administration/roles" },
  {
    name: PERMISSIONS.SYSTEM_CONFIG,
    route: "/administration/system-config",
  },
  { name: PERMISSIONS.AUDIT_LOG, route: "/administration/audit-log" },
];

// Does not call `requirePermission`/`requireAuthenticated`: both redirect
// unauthenticated users to `/login` internally, but this page must check
// `force_password_change` before computing permissions, and reusing the
// guard here would risk a redirect loop (um06-spec §6.8). Renders nothing —
// every path ends in `redirect()`.
export default async function Home(): Promise<never> {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    redirect("/login");
  }

  const user = await findUserById(db, session.user.id);

  // Mirrors `auth/guard.ts`'s `getActiveUser()` stale-session cleanup for
  // a missing/DISABLED/DELETED user — but, unlike that guard, lets PENDING
  // through (forcePasswordChange below sends them to `/set-password`,
  // um09-spec §9.2), since this page deliberately can't reuse the guard
  // (redirect-loop risk on `force_password_change`, um06-spec §6.8).
  if (!user || user.status === "DISABLED" || user.status === "DELETED") {
    await deleteByUserId(db, session.user.id);
    redirect("/login");
  }

  const forcePasswordChange = user.forcePasswordChange;
  const permissionMap = forcePasswordChange
    ? null
    : await resolveEffectivePermissions(session.user.id);

  const route = await resolveRootRedirect(
    { forcePasswordChange },
    permissionMap,
    ROUTE_ORDER,
  );

  redirect(route);
}
