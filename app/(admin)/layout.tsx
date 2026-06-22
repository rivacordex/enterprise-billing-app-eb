import type { Metadata } from "next";

import { getCurrentUserIdentity } from "@/auth/guard";
import { AdminNav } from "@/components/admin-nav";
import { NavSignOutButton } from "@/components/nav-sign-out-button";
import { Toaster } from "@/components/ui/sonner";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Administration — Enterprise Billing",
};

// Navigation sidebar ships in um07 (first administration page) — um06
// deferred it per spec §6.6. No auth check here: each child page handles
// its own guard. um26 adds the sidebar footer (identity strip + sign-out);
// the identity is resolved via `getCurrentUserIdentity` (an `auth/` helper)
// so this file needn't import `db/**`.
export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): Promise<React.JSX.Element> {
  const identity = await getCurrentUserIdentity();

  return (
    <div className="flex h-screen overflow-hidden">
      <aside
        // arbitrary value: --surface-nav isn't re-exposed via @theme inline
        className="flex w-64 flex-shrink-0 flex-col bg-[color:var(--surface-nav)]"
      >
        <div className="border-b border-[color:var(--text-on-brand)]/10 px-4 py-5">
          <span className="text-sm font-semibold text-[color:var(--text-on-brand)]">
            Enterprise Billing
          </span>
        </div>

        {/* Nav links take the available space so the footer pins to the bottom */}
        <div className="flex-1 overflow-y-auto">
          <AdminNav />
        </div>

        {/* Footer — identity strip + sign-out (um26) */}
        {identity && (
          <div className="mt-auto">
            <div className="border-t border-[color:var(--text-on-brand)]/10" />
            <div className="px-4 py-3">
              <p className="truncate text-sm font-medium text-[color:var(--text-on-brand)]">
                {identity.userName}
              </p>
              <p className="mt-0.5 truncate text-xs text-[color:var(--color-primary-300)]">
                {identity.userEmail}
              </p>
            </div>
            <div className="border-t border-[color:var(--text-on-brand)]/10" />
            <div className="p-2">
              <NavSignOutButton />
            </div>
          </div>
        )}
      </aside>
      <main className="flex-1 overflow-y-auto bg-background">{children}</main>
      <Toaster />
    </div>
  );
}
