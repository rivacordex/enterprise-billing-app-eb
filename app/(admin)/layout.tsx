import type { Metadata } from "next";

import { AdminNav } from "@/components/admin-nav";
import { Toaster } from "@/components/ui/sonner";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Administration — Enterprise Billing",
};

// Navigation sidebar ships in um07 (first administration page) — um06
// deferred it per spec §6.6. No auth check here: each child page handles
// its own guard.
export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
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
        <AdminNav />
      </aside>
      <main className="flex-1 overflow-y-auto bg-background">{children}</main>
      <Toaster />
    </div>
  );
}
