import type { Metadata } from "next";
import { cookies } from "next/headers";

import { getCurrentUserIdentity, getEffectivePermissions } from "@/auth/guard";
import { AppShell } from "@/components/app-shell";
import { Toaster } from "@/components/ui/sonner";
import { SIDEBAR_COOKIE, resolveSidebarCollapsed } from "@/lib/sidebar";
import {
  getAppName,
  getBrandingLogo,
} from "@/services/system-config/app-config-read.service";

export const dynamic = "force-dynamic";

// Dynamic so the tab title tracks the configured `app_name` (static `metadata`
// exports can't read the DB); `getAppName()` is `React.cache`d, so it shares
// the single per-request read with the layout body below.
export async function generateMetadata(): Promise<Metadata> {
  return { title: `Administration — ${await getAppName()}` };
}

// Navigation chrome ships in um07 (first administration page) — um06 deferred
// it per spec §6.6. No auth check here: each child page handles its own guard.
// The persisted collapse cookie, the signed-in identity, the effective
// permission map (show/hide only) and the branding are all resolved
// server-side and passed as plain-serializable props into the `"use client"`
// `AppShell`, which owns live collapse state and renders the top bar + sidebar
// + `<main>` (plan §3.4 / §3.9 — the top bar moved the brand, toggle, identity
// and sign-out out of the sidebar).
export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): Promise<React.JSX.Element> {
  const cookieValue = (await cookies()).get(SIDEBAR_COOKIE)?.value;
  const identity = await getCurrentUserIdentity();
  // cm03-spec §2.3.5: one added call to um06's existing resolver, not a new
  // resolver. Omitted when there is no resolved identity — `visibleSections`
  // then fails closed (D6).
  const permissionMap = identity
    ? await getEffectivePermissions(identity.userId)
    : undefined;
  const logo = await getBrandingLogo();
  const appName = await getAppName();

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppShell
        defaultCollapsed={resolveSidebarCollapsed(cookieValue)}
        identity={identity}
        permissionMap={permissionMap}
        logo={logo}
        appName={appName}
      >
        {children}
      </AppShell>
      <Toaster />
    </div>
  );
}
