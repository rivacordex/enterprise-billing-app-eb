"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { label: "Users", href: "/administration/users" },
  { label: "Roles", href: "/administration/roles" },
  { label: "System Configuration", href: "/administration/system-config" },
  { label: "Audit Log", href: "/administration/audit-log" },
] as const;

// Scaffolding for all four admin pages (um07-spec §7.6) — only Users has a
// page in this unit, the rest 404 until their units ship. Intentionally not
// hidden or disabled.
export function AdminNav(): React.JSX.Element {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col py-2">
      <span className="px-4 pt-2 pb-1 text-overline text-[color:var(--text-on-brand)]/60">
        Administration
      </span>
      {NAV_ITEMS.map((item) => {
        const isActive = pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "border-l-[3px] px-4 py-2.5 text-[13px] outline-none focus-visible:[box-shadow:var(--focus-ring)]",
              isActive
                ? "border-[color:var(--color-primary-200)] bg-[color:var(--surface-selected)] text-[color:var(--text-primary)]"
                : "border-transparent text-[color:var(--text-on-brand)] hover:bg-[color:var(--action-ghost-hover)]",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
