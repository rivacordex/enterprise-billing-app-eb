import type { Database } from "@/db/client";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import type { BillRunAccountInsert } from "@/db/schema/billing/bill-run-account";

// bm03-spec §Design/§6/§7 — the scoping snapshot write: one INSERT of every
// row (`PENDING` + `EXCLUDED`) built by `scopeAccounts`, inside the trigger
// transaction. No update/delete surface in this unit — bm04+ owns the
// per-account status writes as the engine progresses.
export const billRunAccountRepository = {
  async insertSnapshot(
    tx: Database,
    rows: BillRunAccountInsert[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(billRunAccount).values(rows);
  },
};
