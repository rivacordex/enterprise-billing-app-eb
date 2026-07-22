"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  Lock,
  Package,
  PackagePlus,
  ScrollText,
  Settings,
  ShieldHalf,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { hasLevel, type EffectivePermissionMap } from "@/types/permissions";
import type { PermissionName, PermissionType } from "@/types/rbac";

// Roles → `ShieldHalf` (not `ShieldCheck`): the filled shield-check glyph is
// already the SSO `AuthMethodBadge` (ui-context §3.5), so reusing it for Roles
// would make one glyph mean two things. `ShieldHalf` stays in the shield/
// authority family (right for RBAC) while staying distinct. `Settings` for
// System Configuration matches `ConfigTable`'s empty-state icon (um28-spec §2.5).
// `Package` for Product Offering: catalog/goods family, no glyph collision
// with existing nav or badge icons. `Building2` for View Customer: the
// organization/legal-entity glyph (the page is about `organization` +
// `party_role`, not a person). `UserCog` for Manage Customer: the
// administer-a-person-like-record glyph, distinct from `Settings`'s
// gear-only meaning and from `Users` (already User Management's).
// `PackagePlus` for Manage Products: same catalog/goods family as `Package`
// (View Product), signaling the create/mutate capability the same way
// `Building2`/`UserCog` stay in one semantic domain while remaining visually
// distinct; no glyph collision with any existing nav or badge icon.
type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  // cm03: only "Manage Customer" sets this — the first nav item whose
  // render depends on the viewer's permission level (cm03-spec §2.3.1).
  requiredPermission?: { name: PermissionName; level: PermissionType };
};
type NavSection = { caption: string; items: ReadonlyArray<NavItem> };

const NAV_SECTIONS: ReadonlyArray<NavSection> = [
  {
    caption: "Products",
    items: [
      {
        label: "View Product",
        href: "/products/product-offering",
        icon: Package,
      },
      {
        label: "Manage Products",
        href: "/products/manage-products",
        icon: PackagePlus,
      },
    ],
  },
  {
    caption: "Customer",
    items: [
      {
        label: "View Customer",
        href: "/customers/view",
        icon: Building2,
        requiredPermission: { name: "customers", level: "READ" },
      },
      {
        label: "Manage Customer",
        href: "/customers/manage",
        icon: UserCog,
        requiredPermission: { name: "customers", level: "EDIT" },
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
  // cm03-spec §2.3.2: fail-closed if omitted — an item with a
  // `requiredPermission` renders locked, never falls back to unlocked.
  permissionMap?: EffectivePermissionMap | undefined;
}

export function AdminNav({
  collapsed = false,
  permissionMap,
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
            // Fail-closed (cm03-spec §2.3.2): no `permissionMap` prop means
            // any item declaring `requiredPermission` renders locked, never
            // silently unlocked. `hasLevel` itself requires a real map, so
            // the `undefined` case is handled here rather than in `um06`'s helper.
            const locked =
              item.requiredPermission !== undefined &&
              !(permissionMap
                ? hasLevel(
                    permissionMap,
                    item.requiredPermission.name,
                    item.requiredPermission.level,
                  )
                : false);
            const itemActive = !locked && isActive;

            const boxClassName = cn(
              "flex items-center overflow-hidden border-l-[3px] outline-none focus-visible:[box-shadow:var(--focus-ring)]",
              collapsed ? "justify-center px-2 py-1" : "gap-2.5 px-4 py-2.5",
              // The left-border accent belongs to the expanded pill only;
              // collapsed active is a centered light square (border dropped).
              !collapsed && itemActive
                ? "border-[color:var(--color-primary-200)] bg-[color:var(--surface-selected)] text-[color:var(--text-primary)]"
                : !collapsed
                  ? "border-transparent text-[color:var(--text-on-brand)] hover:bg-[color:var(--action-ghost-hover)]"
                  : "border-transparent",
              // Belt-and-suspenders alongside `aria-disabled` and the
              // non-`<a>` element (cm03-spec §3.2) against inherited
              // hover/focus styling meant for real links.
              locked && "cursor-not-allowed opacity-50",
            );

            const iconWrapClassName = cn(
              "flex shrink-0 items-center justify-center",
              collapsed &&
                (itemActive
                  ? "size-9 rounded-sm bg-[color:var(--surface-selected)] text-[color:var(--text-primary)]"
                  : "size-9 rounded-sm text-[color:var(--text-on-brand)] hover:bg-[color:var(--action-ghost-hover)]"),
            );

            const labelClassName = cn(
              "overflow-hidden text-[13px] whitespace-nowrap transition-[max-width,opacity] duration-200",
              collapsed ? "max-w-0 opacity-0" : "max-w-[12rem] opacity-100",
            );

            if (locked) {
              const permissionResource =
                item.requiredPermission?.name === "customers"
                  ? "customer"
                  : item.requiredPermission?.name.replace(/_/g, " ");

              return (
                <span
                  key={item.href}
                  role="link"
                  aria-disabled="true"
                  // Collapsed: same plain-label tooltip convention as every
                  // other item; expanded: the reason it's inert (cm03-spec §2.3.4).
                  title={
                    collapsed
                      ? item.label
                      : `Requires ${permissionResource} ${item.requiredPermission?.level.toLowerCase()} access`
                  }
                  className={boxClassName}
                >
                  <span className={iconWrapClassName}>
                    <Icon size={collapsed ? 18 : 16} aria-hidden />
                  </span>
                  <span className={labelClassName}>{item.label}</span>
                  {!collapsed && (
                    <Lock
                      size={14}
                      aria-hidden
                      className="ml-auto text-[color:var(--text-on-brand)]/40"
                    />
                  )}
                </span>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
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
