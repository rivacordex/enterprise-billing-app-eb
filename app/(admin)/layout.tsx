import type { Metadata } from "next";
import { cookies } from "next/headers";

import { getCurrentUserIdentity } from "@/auth/guard";
import { AdminSidebar } from "@/components/admin-sidebar";
import { Toaster } from "@/components/ui/sonner";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";
import { getBrandingLogo } from "@/services/system-config/app-config-read.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Administration — Enterprise Billing",
};

// Navigation sidebar ships in um07 (first administration page) — um06
// deferred it per spec §6.6. No auth check here: each child page handles
// its own guard. um26 adds the sidebar footer (identity strip + sign-out);
// um28 extracts the whole `<aside>` into the `"use client"` `AdminSidebar`
// (it owns live collapse state) and reads the persisted collapse cookie +
// branding logo server-side, passing them down as plain-serializable props.
export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): Promise<React.JSX.Element> {
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "1";
  const identity = await getCurrentUserIdentity();
  const logo = await getBrandingLogo();

  return (
    <div className="flex h-screen overflow-hidden">
      <AdminSidebar
        defaultCollapsed={collapsed}
        identity={identity}
        logo={logo}
      />
      <main className="flex-1 overflow-y-auto bg-background">{children}</main>
      <Toaster />
    </div>
  );
}
