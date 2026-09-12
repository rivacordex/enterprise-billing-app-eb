import { meetsLevel, type EffectivePermissionMap } from "@/types/permissions";
import type { PermissionName, PermissionType } from "@/types/rbac";

// The single source of truth for every directory page's route, label, and
// required `permission : level` (plan §3.1). The sidebar nav, the Homepage, and
// the CI guardrail gate all read this one array, so a page's permission can
// never be declared in two places and drift. Pure data + one pure selector:
// no `next/*`, no `db/**`, no React, no lucide — it imports only `types`, so it
// satisfies the deny-by-default `lib` boundary rule and is unit-testable in
// plain vitest. The lucide glyph for each href lives in `components/nav-icons.ts`
// (presentation, barred from `lib/`).

export interface NavPage {
  readonly label: string;
  readonly href: string;
  // Required, not optional — "forgot to declare one" is a compile error, not an
  // unguarded link.
  readonly permission: PermissionName;
  readonly level: PermissionType;
}

export interface NavSection {
  readonly caption: string;
  readonly items: readonly NavPage[];
  /** Accounts only: items carry the ?party&fa&ban selection (D7, um-era). */
  readonly carriesAccountsContext?: true;
}

// The `permission : level` of each entry equals that page's own
// `requirePermission(...)` guard — the §6.3 guardrail gate asserts the two are
// equal, so this table can never drift from the guards. Manage Products is
// EDIT (not READ) — the one item where declaring the module at READ would still
// leave a broken link; Accounts Settings is READ per D7.
// `as const satisfies` (not a `: readonly NavSection[]` annotation): the
// literal hrefs must survive into `NavHref` below so `Record<NavHref, …>` in
// `components/nav-icons.ts` makes a missing/stale icon a compile error. A plain
// type annotation would widen `href` to `string` and silently defeat that.
export const NAV_REGISTRY = [
  {
    caption: "Billing",
    items: [
      {
        label: "Bill Runs",
        href: "/billing/bill-runs",
        permission: "billrun_view",
        level: "READ",
      },
    ],
  },
  {
    caption: "Customer",
    items: [
      {
        label: "View Customer",
        href: "/customers/view",
        permission: "customers",
        level: "READ",
      },
      {
        label: "Manage Customer",
        href: "/customers/manage",
        permission: "customers",
        level: "EDIT",
      },
    ],
  },
  {
    caption: "Accounts",
    carriesAccountsContext: true,
    items: [
      {
        label: "Overview",
        href: "/accounts/overview",
        permission: "accounts_view",
        level: "READ",
      },
      {
        label: "Transactions",
        href: "/accounts/transactions",
        permission: "accounts_transactions",
        level: "READ",
      },
      {
        label: "Ledger Explorer",
        href: "/accounts/ledger",
        permission: "accounts_view",
        level: "READ",
      },
      {
        label: "Chart of Accounts",
        href: "/accounts/chart-of-accounts",
        permission: "accounts_config",
        level: "READ",
      },
      {
        label: "GL Journal",
        href: "/accounts/gl-journal",
        permission: "accounts_config",
        level: "READ",
      },
    ],
  },
  {
    caption: "Products",
    items: [
      {
        label: "View Product",
        href: "/products/product-offering",
        permission: "products",
        level: "READ",
      },
      {
        label: "Manage Products",
        href: "/products/manage-products",
        permission: "products",
        level: "EDIT",
      },
      {
        label: "Orders",
        href: "/products/orders",
        permission: "product_orders",
        level: "READ",
      },
      {
        label: "Subscriptions",
        href: "/products/subscriptions",
        permission: "product_inventory",
        level: "READ",
      },
    ],
  },
  {
    caption: "Administration",
    items: [
      {
        label: "Users",
        href: "/administration/users",
        permission: "users",
        level: "READ",
      },
      {
        label: "Roles",
        href: "/administration/roles",
        permission: "roles",
        level: "READ",
      },
      {
        label: "System Configuration",
        href: "/administration/system-config",
        permission: "system_config",
        level: "READ",
      },
      {
        label: "Audit Log",
        href: "/administration/audit-log",
        permission: "audit_log",
        level: "READ",
      },
      {
        // D7: READ, not EDIT — the page guard drops to READ so the only role
        // allowed to read the linked /flows reference can reach it; the page's
        // mutation controls grey out unless the viewer also holds EDIT.
        label: "Accounts Settings",
        href: "/administration/accounts-settings",
        permission: "accounts_config",
        level: "READ",
      },
    ],
  },
] as const satisfies readonly NavSection[];

/** Every href in the registry — exhaustive icon typing and the CI gate. */
export type NavHref = (typeof NAV_REGISTRY)[number]["items"][number]["href"];

/**
 * The shape `visibleSections` returns: identical to `NavSection`/`NavPage` but
 * with `href` narrowed from `string` to the literal `NavHref` union, so
 * consumers can index `NAV_ICONS` (`Record<NavHref, LucideIcon>`) directly —
 * no cast, and a missing icon stays a compile error end to end. (`NavPage.href`
 * itself can't be `NavHref` without a circular reference, since `NavHref` is
 * derived from the registry that satisfies `NavPage`.)
 */
export type VisibleNavSection = Omit<NavSection, "items"> & {
  readonly items: readonly (Omit<NavPage, "href"> & {
    readonly href: NavHref;
  })[];
};

/**
 * Show/hide only — never an enforcement boundary (Inv. #3).
 * Fail-closed: a null/undefined map yields no sections at all (D6).
 * Sections whose items are all filtered out are dropped entirely.
 */
export function visibleSections(
  map: EffectivePermissionMap | null | undefined,
): readonly VisibleNavSection[] {
  if (!map) return [];
  return NAV_REGISTRY.map((s) => ({
    ...s,
    items: s.items.filter((i) => meetsLevel(map[i.permission], i.level)),
  })).filter((s) => s.items.length > 0);
}
