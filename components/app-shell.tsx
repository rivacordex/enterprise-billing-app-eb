"use client";

import { useState } from "react";

import { AdminSidebar } from "@/components/admin-sidebar";
import { AppTopBar } from "@/components/app-topbar";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";
import type { EffectivePermissionMap } from "@/types/permissions";
import type { BrandingLogo } from "@/types/system-config";

interface AppShellProps {
  defaultCollapsed: boolean;
  identity: { userName: string; userEmail: string } | null;
  permissionMap?: EffectivePermissionMap | undefined;
  logo: BrandingLogo | null;
  appName: string;
  // The server-rendered page subtree, passed THROUGH this client component as a
  // prop (supported in the App Router) — the reason this doesn't turn every
  // page into a client component.
  children: React.ReactNode;
}

// The merge point (plan §3.4). Collapse state is shared by the top bar (which
// owns the toggle) and the sidebar (which reacts to it), so it moved up one
// level from the old `AdminSidebar`. `"use client"` because it owns live state.
export function AppShell({
  defaultCollapsed,
  identity,
  permissionMap,
  logo,
  appName,
  children,
}: AppShellProps): React.JSX.Element {
  // Seeded at init from the prop (never synced via useEffect) so SSR and the
  // first client render agree — no hydration mismatch, and the enforced
  // `react-hooks/set-state-in-effect` rule is satisfied.
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  function toggle(): void {
    const next = !collapsed;
    setCollapsed(next); // instant, local — no Server Action round-trip
    // Non-HttpOnly (JS must write it), one-year max-age, lax; carries no
    // sensitive data. Restores the choice only on a full reload — App-Router
    // layouts persist across in-app nav, so collapse already survives there.
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <>
      <AppTopBar
        collapsed={collapsed}
        onToggle={toggle}
        identity={identity}
        logo={logo}
        appName={appName}
      />
      <div className="flex flex-1 overflow-hidden">
        <AdminSidebar collapsed={collapsed} permissionMap={permissionMap} />
        <main className="flex-1 overflow-y-auto bg-background">{children}</main>
      </div>
    </>
  );
}
