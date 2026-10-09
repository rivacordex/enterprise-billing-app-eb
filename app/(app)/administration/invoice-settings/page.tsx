import { redirect } from "next/navigation";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";

// bm55-spec §Design D4, code-standards Part 2 Next.js rule 1 — the Invoice
// Settings entry only redirects. Until bm56 ships Company profile the target
// is the Invoice template page; bm56 switches it to `company-profile`. The
// guard matches the nav entry (`invoice_settings : READ`).
export const dynamic = "force-dynamic";

export default async function InvoiceSettingsPage(): Promise<never> {
  await requirePermission(PERMISSIONS.INVOICE_SETTINGS, LEVELS.READ);
  redirect("/administration/invoice-settings/invoice-template");
}
