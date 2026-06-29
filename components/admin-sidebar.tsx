"use client";

import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { AdminNav } from "@/components/admin-nav";
import { BrandLogo } from "@/components/brand-logo";
import { NavSignOutButton } from "@/components/nav-sign-out-button";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";
import { cn } from "@/lib/utils";
import type { BrandingLogo } from "@/types/system-config";

interface AdminSidebarProps {
  defaultCollapsed: boolean;
  identity: { userName: string; userEmail: string } | null;
  logo: BrandingLogo | null;
}

// The collapsible left admin panel (um28-spec §2.4) — the merge point that
// owns *live* collapse state, so it is `"use client"`. The logo + identity
// are server-resolved and passed in as plain-serializable props (DB access
// stays in the server layout behind `services/**`, architecture Inv. #14).
// The header hosts both the logo (left) and the collapse toggle (right);
// building it in two places would conflict, so the whole `<aside>` lives here.
export function AdminSidebar({
  defaultCollapsed,
  identity,
  logo,
}: AdminSidebarProps): React.JSX.Element {
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

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleButton = (
    <button
      type="button"
      onClick={toggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      className="inline-flex shrink-0 items-center justify-center rounded-sm p-1.5 text-[color:var(--color-primary-300)] transition-colors outline-none hover:bg-[color:var(--color-primary-700)] hover:text-[color:var(--text-on-brand)] focus-visible:[box-shadow:var(--focus-ring)]"
    >
      <ToggleIcon size={18} aria-hidden />
    </button>
  );

  return (
    <aside
      className={cn(
        "flex flex-shrink-0 flex-col bg-[color:var(--surface-nav)] motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-in-out",
        collapsed ? "w-16" : "w-64",
      )}
    >
      {/* Header — logo + toggle. Collapsed stacks the mark over the toggle. */}
      <div className="border-b border-[color:var(--text-on-brand)]/10 px-3 py-5">
        {collapsed ? (
          <div className="flex flex-col items-center gap-3">
            <BrandLogo logo={logo} variant="nav-collapsed" />
            {toggleButton}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 px-1">
            <BrandLogo logo={logo} variant="nav" />
            {toggleButton}
          </div>
        )}
      </div>

      {/* Nav links take the available space so the footer pins to the bottom. */}
      <div className="flex-1 overflow-x-hidden overflow-y-auto">
        <AdminNav collapsed={collapsed} />
      </div>

      {/* Footer — identity strip + sign-out (um26). Collapsed: sign-out icon
          only, no identity strip (um28-spec §2.5). */}
      {identity && (
        <div className="mt-auto">
          <div className="border-t border-[color:var(--text-on-brand)]/10" />
          {!collapsed && (
            <>
              <div className="px-4 py-3">
                <p className="truncate text-sm font-medium text-[color:var(--text-on-brand)]">
                  {identity.userName}
                </p>
                <p className="mt-0.5 truncate text-xs text-[color:var(--color-primary-300)]">
                  {identity.userEmail}
                </p>
              </div>
              <div className="border-t border-[color:var(--text-on-brand)]/10" />
            </>
          )}
          <div className="p-2">
            <NavSignOutButton collapsed={collapsed} />
          </div>
        </div>
      )}
    </aside>
  );
}
