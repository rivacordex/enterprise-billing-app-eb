import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import type { BillRunAccountInsert } from "@/db/schema/billing/bill-run-account";
import type { AccountStatus } from "@/types/billing";

// bm03-spec §Design/§6/§7 — the scoping snapshot write: one INSERT of every
// row (`PENDING` + `EXCLUDED`) built by `scopeAccounts`, inside the trigger
// transaction. bm04 adds the per-account status read/write the stage handler
// needs as the engine progresses.
export const billRunAccountRepository = {
  async insertSnapshot(
    tx: Database,
    rows: BillRunAccountInsert[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(billRunAccount).values(rows);
  },

  // bm04-spec §Design/§Implementation §8 — read before advancing, inside the
  // run-row-locked stage-signal transaction (concurrency is already handled
  // by `findByIdForUpdate` on the parent `bill_run` row, architecture Inv.
  // #12 — no separate row lock needed here).
  async findStatus(
    tx: Database,
    billRunId: string,
    billingAccountId: string,
  ): Promise<{ status: AccountStatus } | null> {
    const [row] = await tx
      .select({ status: billRunAccount.status })
      .from(billRunAccount)
      .where(
        and(
          eq(billRunAccount.refBillRunId, billRunId),
          eq(billRunAccount.refBillingAccountId, billingAccountId),
        ),
      )
      .limit(1);
    return row ? { status: row.status as AccountStatus } : null;
  },

  // bm04-spec §Design/§Implementation §8 — the per-account advance write.
  async updateStatus(
    tx: Database,
    billRunId: string,
    billingAccountId: string,
    data: {
      status: AccountStatus;
      errorCode: string | null;
      errorDetail: string | null;
    },
  ): Promise<void> {
    await tx
      .update(billRunAccount)
      .set({
        status: data.status,
        errorCode: data.errorCode,
        errorDetail: data.errorDetail,
        lastProcessedAt: new Date(),
      })
      .where(
        and(
          eq(billRunAccount.refBillRunId, billRunId),
          eq(billRunAccount.refBillingAccountId, billingAccountId),
        ),
      );
  },

  // bm04-spec §Design/§Implementation §8 — every account status for the run,
  // the input to the pure `computeRunStatus` recompute and to the Workflow
  // tab's derived summary/timeline (never the optional cache).
  async listStatusesForRun(
    tx: Database,
    billRunId: string,
  ): Promise<{ billingAccountId: string; status: AccountStatus }[]> {
    const rows = await tx
      .select({
        billingAccountId: billRunAccount.refBillingAccountId,
        status: billRunAccount.status,
      })
      .from(billRunAccount)
      .where(eq(billRunAccount.refBillRunId, billRunId))
      .orderBy(billRunAccount.refBillingAccountId);
    return rows.map((r) => ({ ...r, status: r.status as AccountStatus }));
  },
};
