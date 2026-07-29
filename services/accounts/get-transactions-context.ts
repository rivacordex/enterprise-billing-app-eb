// Read side for the Transactions page (ac07-spec §2.5) — pending approvals
// for the selected FA and the refund workbench's assigned items/available
// balance for the selected BAN. Pure composition over repositories; no
// pgledger call lives here directly (only via `ledgerRepository`).

import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import type { Document } from "@/db/schema/billing/documents";
import {
  getUnappliedCashAvailable,
  listAssignedItemsForBan,
} from "@/services/accounts/refund-payment";
import type { AssignedItem } from "@/services/accounts/refund-payment";

export async function listPendingApprovals(
  financialAccountId: string,
): Promise<Document[]> {
  return documentRepository.findPendingApprovalsForFinancialAccount(
    db,
    financialAccountId,
  );
}

export async function getRefundWorkbenchData(
  financialAccountId: string,
  billingAccountId: string,
): Promise<{ assignedItems: AssignedItem[]; unappliedCashAvailable: string }> {
  const [assignedItems, unappliedCashAvailable] = await Promise.all([
    listAssignedItemsForBan(billingAccountId),
    getUnappliedCashAvailable(financialAccountId),
  ]);
  return { assignedItems, unappliedCashAvailable };
}
