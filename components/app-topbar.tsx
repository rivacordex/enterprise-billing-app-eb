"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { BrandLogo } from "@/components/brand-logo";
import { NavSignOutButton } from "@/components/nav-sign-out-button";
import { cn } from "@/lib/utils";
import type { BrandingLogo } from "@/types/system-config";

interface AppTopBarProps {
  collapsed: boolean;
  // The collapse toggle lives here now but the state lives in `AppShell`, so
  // the handler is injected rather than owned.
  onToggle: () => void;
  identity: { userName: string; userEmail: string } | null;
  logo: BrandingLogo | null;
  appName: string;
}

// The persistent, full-width top bar (plan §3.5). `--surface-topbar` over the
// darker `--surface-nav` sidebar, a `--color-primary-900` bottom hairline,
// ~56px tall. Left→right: brand (far left, the only brand surface in the app —
// D10/D13), collapse toggle, Home, spacer, identity, sign-out. Narrow-width
// degradation drops the email, then the "Home" label, then the wordmark; the
// toggle, Home icon and sign-out never drop.
export function AppTopBar({
  collapsed,
  onToggle,
  identity,
  logo,
  appName,
}: AppTopBarProps): React.JSX.Element {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <header className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-[color:var(--color-primary-900)] bg-[color:var(--surface-nav)] px-3 text-[color:var(--text-on-brand)]">
      {/* Brand — the leftmost element; wrapped in a Link so the logo is also a
          route home (the standard affordance). Never moves with collapse/route. */}
      <Link
        href="/"
        aria-label={`${appName} — Home`}
        className="flex max-w-[320px] min-w-0 items-center rounded-sm outline-none focus-visible:[box-shadow:var(--focus-ring)]"
      >
        <BrandLogo logo={logo} variant="topbar" appName={appName} />
      </Link>

      {/* Collapse toggle — moved from the sidebar header verbatim (same icons,
          aria-label/aria-expanded, hover token). Sits immediately right of the
          brand, over the sidebar it controls. */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        className="inline-flex shrink-0 items-center justify-center rounded-sm p-1.5 text-[color:var(--color-primary-300)] transition-colors outline-none hover:bg-[color:var(--color-primary-700)] hover:text-[color:var(--text-on-brand)] focus-visible:[box-shadow:var(--focus-ring)]"
      >
        <ToggleIcon size={18} aria-hidden />
      </button>

      {/* Home */}
      <Link
        href="/"
        aria-current={isHome ? "page" : undefined}
        className={cn(
          "ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1.5 text-sm transition-colors outline-none hover:bg-[color:var(--color-primary-700)] hover:text-[color:var(--text-on-brand)] focus-visible:[box-shadow:var(--focus-ring)]",
          isHome
            ? "text-[color:var(--text-on-brand)]"
            : "text-[color:var(--color-primary-300)]",
        )}
      >
        <Home size={16} aria-hidden />
        <span className="hidden sm:inline">Home</span>
      </Link>

      <div className="flex-1" />

      {/* Identity — name · email on one line (D11); the email half drops first
          on narrow viewports, the name remains. */}
      {identity && (
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="truncate text-[color:var(--text-on-brand)]">
            {identity.userName}
          </span>
          <span
            aria-hidden
            className="hidden text-[color:var(--color-primary-300)] sm:inline"
          >
            ·
          </span>
          <span className="hidden min-w-0 truncate text-[color:var(--color-primary-300)] sm:inline">
            {identity.userEmail}
          </span>
        </div>
      )}

      {/* Sign out — reused as-is; already token-correct for dark chrome. */}
      <div className="shrink-0">
        <NavSignOutButton />
      </div>
    </header>
  );
}
