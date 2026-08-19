import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { PERMISSIONS, LEVELS } from "@/auth/permission-constants";
import { BillRunsEmptyState } from "@/components/billing/bill-runs-empty-state";

// Authenticated, uncached — the guard reads the session and (from bm02) run
// status/totals are read live and never revalidate-cached (code-standards §3.6).
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Bill Runs" };

export default async function BillRunsPage(): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.BILLRUN_VIEW, LEVELS.READ);
  return <BillRunsEmptyState />;
}
