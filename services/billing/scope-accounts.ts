import type { Database } from "@/db/client";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import { inventoryStatusHistoryRepository } from "@/db/repositories/inventory/inventory-status-history.repository";
import type { BillRunAccountInsert } from "@/db/schema/billing/bill-run-account";
import { firstOfMonth } from "@/services/billing/derive-periods";
import { isPartialPeriod } from "@/services/billing/partial-period";

// bm03-spec §Design/§6. Snapshots the cycle's eligible active accounts into
// `bill_run_account` rows, split by the partial-period predicate. Called
// inside the trigger's transaction (`tx`), before the run flips to
// PROCESSING, so a failure anywhere here rolls back with no orphan snapshot.

export interface ScopeAccountsRun {
  billRunId: string;
  refBillCycleId: string;
  periodStart: string;
  periodEnd: string;
}

export interface ScopeAccountsResult {
  pending: BillRunAccountInsert[];
  excluded: BillRunAccountInsert[];
}

export async function scopeAccounts(
  tx: Database,
  run: ScopeAccountsRun,
): Promise<ScopeAccountsResult> {
  const accounts = await billingAccountRepository.findActiveByCycleId(
    tx,
    run.refBillCycleId,
  );
  if (accounts.length === 0) return { pending: [], excluded: [] };

  const accountIds = accounts.map((a) => a.billingAccountId);
  const windows =
    await productInventoryRepository.findWindowsByBillingAccountIds(
      tx,
      accountIds,
    );

  const inventoryIds = windows.map((w) => w.productInventoryId);
  const transitions =
    inventoryIds.length === 0
      ? []
      : await inventoryStatusHistoryRepository.findTransitionsByInventoryIds(
          tx,
          inventoryIds,
        );

  const windowsByAccount = new Map<string, typeof windows>();
  for (const w of windows) {
    const list = windowsByAccount.get(w.billingAccountId);
    if (list) list.push(w);
    else windowsByAccount.set(w.billingAccountId, [w]);
  }

  const transitionsByInventory = new Map<string, typeof transitions>();
  for (const t of transitions) {
    const list = transitionsByInventory.get(t.productInventoryId);
    if (list) list.push(t);
    else transitionsByInventory.set(t.productInventoryId, [t]);
  }

  const periodPartition = firstOfMonth(run.periodStart);
  const pending: BillRunAccountInsert[] = [];
  const excluded: BillRunAccountInsert[] = [];

  for (const account of accounts) {
    const accountWindows = windowsByAccount.get(account.billingAccountId) ?? [];
    const accountTransitions = accountWindows.flatMap(
      (w) => transitionsByInventory.get(w.productInventoryId) ?? [],
    );

    const partial = isPartialPeriod({
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      subscriptions: accountWindows,
      transitions: accountTransitions,
    });

    const row: BillRunAccountInsert = {
      refBillRunId: run.billRunId,
      refBillingAccountId: account.billingAccountId,
      periodPartition,
      status: partial ? "EXCLUDED" : "PENDING",
      errorCode: partial ? "PARTIAL_PERIOD" : null,
    };

    if (partial) excluded.push(row);
    else pending.push(row);
  }

  return { pending, excluded };
}
