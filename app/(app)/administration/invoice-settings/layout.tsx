import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";

// bm55-spec §Design D4 — the Administration › Invoice Settings shell. Guarded
// at `invoice_settings : READ` (each page re-guards, Inv #49); renders the
// heading over the child page. Each page renders its own tab strip (a layout
// cannot see the current path, so only the page can mark the active tab).
export const dynamic = "force-dynamic";

export default async function InvoiceSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.INVOICE_SETTINGS, LEVELS.READ);

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-h1 font-semibold text-foreground">
        Invoice Settings
      </h1>
      {children}
    </div>
  );
}
