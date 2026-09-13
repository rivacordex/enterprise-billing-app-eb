"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReadonlyURLSearchParams } from "next/navigation";

import { NAV_ICONS } from "@/components/nav-icons";
import { visibleSections } from "@/lib/nav-registry";
import { cn } from "@/lib/utils";
import type { EffectivePermissionMap } from "@/types/permissions";
import { parseAccountsContext } from "@/validation/accounts/parse-accounts-context";

// D7: fixed order (§2.6) — deterministic hrefs regardless of incoming order.
const CONTEXT_KEYS = ["party", "fa", "ban"] as const;

// Module-private (§3.3): nav-render concern; `parseAccountsContext` remains
// the only *parser* (code-standards §3.1).
function accountsContextQuery(sp: ReadonlyURLSearchParams): string {
  // `sp.get` returns the FIRST value for a repeated key — matches
  // parseAccountsContext's `first()` helper semantics exactly (§2.3c).
  const ctx = parseAccountsContext({
    party: sp.get("party") ?? undefined,
    fa: sp.get("fa") ?? undefined,
    ban: sp.get("ban") ?? undefined,
  });
  const qs = new URLSearchParams();
  for (const k of CONTEXT_KEYS) if (ctx[k]) qs.set(k, ctx[k]);
  return qs.toString();
}

interface AdminNavProps {
  // um28-spec §2.5: the icon-rail variant. Labels stay in the DOM and fade
  // (max-width + opacity) in step with the 200ms width transition rather than
  // being conditionally unmounted, so the text doesn't pop mid-animation.
  collapsed?: boolean;
  // Show/hide only, never an enforcement boundary (Inv. #3). Fail-closed (D6):
  // a null/undefined map yields no sections at all — `visibleSections` handles
  // that, so there is no "locked" fallback to render.
  permissionMap?: EffectivePermissionMap | undefined;
}

export function AdminNav({
  collapsed = false,
  permissionMap,
}: AdminNavProps = {}): React.JSX.Element {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ctxQuery = accountsContextQuery(searchParams);

  // Registry-driven (plan §3.3): items the viewer may open, grouped; denied
  // pages and empty sections are dropped entirely (D2 — no "locked" treatment).
  const sections = visibleSections(permissionMap);

  return (
    <nav className="flex flex-col py-2">
      {sections.map((section, index) => (
        <Fragment key={section.caption}>
          {/* Divider count follows the number of *visible* sections, not a
              fixed five (plan §3.3). */}
          {collapsed && index > 0 && (
            <hr
              aria-hidden
              className="mx-3 my-2 border-t border-[color:var(--text-on-brand)]/10"
            />
          )}
          {/* caption is hidden in the collapsed rail (um28-spec §2.5). */}
          {!collapsed && (
            <span
              className={cn(
                "px-4 pt-2 pb-1 text-[15px] font-semibold text-[color:var(--text-on-brand)]/60",
                index > 0 && "mt-2",
              )}
            >
              {section.caption}
            </span>
          )}
          {section.items.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            // `item.href` is typed `NavHref` (via visibleSections), so this
            // indexes the exhaustive `Record<NavHref, …>` with no cast — a
            // missing icon is a compile error, not a runtime crash.
            const Icon = NAV_ICONS[item.href];

            const boxClassName = cn(
              "flex items-center overflow-hidden border-l-[3px] outline-none focus-visible:[box-shadow:var(--focus-ring)]",
              collapsed ? "justify-center px-2 py-1" : "gap-2.5 px-4 py-2.5",
              // The left-border accent belongs to the expanded pill only;
              // collapsed active is a centered light square (border dropped).
              !collapsed && isActive
                ? "border-[color:var(--color-primary-200)] bg-[color:var(--surface-selected)] text-[color:var(--text-primary)]"
                : !collapsed
                  ? "border-transparent text-[color:var(--text-on-brand)] hover:bg-[color:var(--color-primary-700)]"
                  : "border-transparent",
            );

            const iconWrapClassName = cn(
              "flex shrink-0 items-center justify-center",
              collapsed &&
                (isActive
                  ? "size-9 rounded-sm bg-[color:var(--surface-selected)] text-[color:var(--text-primary)]"
                  : "size-9 rounded-sm text-[color:var(--text-on-brand)] hover:bg-[color:var(--color-primary-700)]"),
            );

            const labelClassName = cn(
              "overflow-hidden text-[13px] whitespace-nowrap transition-[max-width,opacity] duration-200",
              collapsed ? "max-w-0 opacity-0" : "max-w-[12rem] opacity-100",
            );

            const linkHref =
              section.carriesAccountsContext && ctxQuery
                ? `${item.href}?${ctxQuery}`
                : item.href;

            return (
              <Link
                key={item.href}
                href={linkHref}
                aria-current={isActive ? "page" : undefined}
                // Collapsed: a hover tooltip for sighted users; the (DOM-present,
                // visually-clipped) label still provides the accessible name.
                title={collapsed ? item.label : undefined}
                className={boxClassName}
              >
                <span className={iconWrapClassName}>
                  <Icon size={collapsed ? 18 : 16} aria-hidden />
                </span>
                <span className={labelClassName}>{item.label}</span>
              </Link>
            );
          })}
        </Fragment>
      ))}
    </nav>
  );
}
