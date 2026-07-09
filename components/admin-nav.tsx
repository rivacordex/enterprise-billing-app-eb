"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Package,
  ScrollText,
  Settings,
  ShieldHalf,
  Users,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

// Roles → `ShieldHalf` (not `ShieldCheck`): the filled shield-check glyph is
// already the SSO `AuthMethodBadge` (ui-context §3.5), so reusing it for Roles
// would make one glyph mean two things. `ShieldHalf` stays in the shield/
// authority family (right for RBAC) while staying distinct. `Settings` for
// System Configuration matches `ConfigTable`'s empty-state icon (um28-spec §2.5).
// `Package` for Product Offering: catalog/goods family, no glyph collision
// with existing nav or badge icons.
type NavItem = { label: string; href: string; icon: LucideIcon };
type NavSection = { caption: string; items: ReadonlyArray<NavItem> };

const NAV_SECTIONS: ReadonlyArray<NavSection> = [
  {
    caption: "Products",
    items: [
      {
        label: "Product Offering",
        href: "/products/product-offering",
        icon: Package,
      },
    ],
  },
  {
    caption: "Administration",
    items: [
      { label: "Users", href: "/administration/users", icon: Users },
      { label: "Roles", href: "/administration/roles", icon: ShieldHalf },
      {
        label: "System Configuration",
        href: "/administration/system-config",
        icon: Settings,
      },
      {
        label: "Audit Log",
        href: "/administration/audit-log",
        icon: ScrollText,
      },
    ],
  },
];

interface AdminNavProps {
  // um28-spec §2.5: the icon-rail variant. Labels stay in the DOM and fade
  // (max-width + opacity) in step with the 200ms width transition rather than
  // being conditionally unmounted, so the text doesn't pop mid-animation.
  collapsed?: boolean;
}

export function AdminNav({
  collapsed = false,
}: AdminNavProps = {}): React.JSX.Element {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col py-2">
      {NAV_SECTIONS.map((section, index) => (
        <Fragment key={section.caption}>
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
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                // Collapsed: a hover tooltip for sighted users; the (DOM-present,
                // visually-clipped) label still provides the accessible name.
                title={collapsed ? item.label : undefined}
                className={cn(
                  "flex items-center overflow-hidden border-l-[3px] outline-none focus-visible:[box-shadow:var(--focus-ring)]",
                  collapsed
                    ? "justify-center px-2 py-1"
                    : "gap-2.5 px-4 py-2.5",
                  // The left-border accent belongs to the expanded pill only;
                  // collapsed active is a centered light square (border dropped).
                  !collapsed && isActive
                    ? "border-[color:var(--color-primary-200)] bg-[color:var(--surface-selected)] text-[color:var(--text-primary)]"
                    : !collapsed
                      ? "border-transparent text-[color:var(--text-on-brand)] hover:bg-[color:var(--action-ghost-hover)]"
                      : "border-transparent",
                )}
              >
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center",
                    collapsed &&
                      (isActive
                        ? "size-9 rounded-sm bg-[color:var(--surface-selected)] text-[color:var(--text-primary)]"
                        : "size-9 rounded-sm text-[color:var(--text-on-brand)] hover:bg-[color:var(--action-ghost-hover)]"),
                  )}
                >
                  <Icon size={collapsed ? 18 : 16} aria-hidden />
                </span>
                <span
                  className={cn(
                    "overflow-hidden text-[13px] whitespace-nowrap transition-[max-width,opacity] duration-200",
                    collapsed
                      ? "max-w-0 opacity-0"
                      : "max-w-[12rem] opacity-100",
                  )}
                >
                  {item.label}
                </span>
              </Link>
            );
          })}
        </Fragment>
      ))}
    </nav>
  );
}
