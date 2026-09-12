import { AdminNav } from "@/components/admin-nav";
import { cn } from "@/lib/utils";
import type { EffectivePermissionMap } from "@/types/permissions";

interface AdminSidebarProps {
  // Controlled by `AppShell` (plan §3.6): collapse state now lives one level up
  // in the shell, shared with the top bar that owns the toggle.
  collapsed: boolean;
  // Passed straight through to `AdminNav` — only that component reads it
  // (show/hide only, never an enforcement boundary, Inv. #3).
  permissionMap?: EffectivePermissionMap | undefined;
}

// Navigation-only after the top-bar move (plan §3.6): the brand, toggle,
// identity strip and sign-out all live in `AppTopBar` now. What remains is the
// `<aside>` width transition wrapping `<AdminNav>`.
export function AdminSidebar({
  collapsed,
  permissionMap,
}: AdminSidebarProps): React.JSX.Element {
  return (
    <aside
      className={cn(
        "flex flex-shrink-0 flex-col bg-[color:var(--surface-nav)] motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-in-out",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <div className="flex-1 overflow-x-hidden overflow-y-auto">
        <AdminNav collapsed={collapsed} permissionMap={permissionMap} />
      </div>
    </aside>
  );
}
