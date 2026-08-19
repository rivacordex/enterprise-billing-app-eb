import type { Metadata } from "next";

import { requirePermission } from "@/auth/guard";
import { PERMISSIONS, LEVELS } from "@/auth/permission-constants";
import { BillRunsEmptyState } from "@/components/billing/bill-runs-empty-state";

export const metadata: Metadata = { title: "Bill Runs" };

export default async function BillRunsPage(): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.BILLRUN_VIEW, LEVELS.READ);
  return <BillRunsEmptyState />;
}
