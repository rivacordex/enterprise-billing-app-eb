import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import type { BillRunAccountInsert } from "@/db/schema/billing/bill-run-account";
import { billRunAccountStage } from "@/db/schema/billing/bill-run-account-stage";
import { billRun } from "@/db/schema/billing/bill-run";
import { billingAccount } from "@/db/schema/billing/accounts";
import type { AccountStatus, ErrorClass, Stage } from "@/types/billing";

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
    // Postgres caps a single statement at 65535 bind parameters; a large
    // cycle snapshot (thousands of accounts × ~9 columns) can exceed it, so
    // chunk the insert to stay well under the limit.
    const CHUNK_SIZE = 1000;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await tx.insert(billRunAccount).values(rows.slice(i, i + CHUNK_SIZE));
    }
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
      // Omit to preserve the stored diagnostics (a later non-failing signal
      // must not clear the error that explains a prior failure).
      errorCode?: string | null;
      errorDetail?: string | null;
    },
  ): Promise<void> {
    await tx
      .update(billRunAccount)
      .set({
        status: data.status,
        ...(data.errorCode !== undefined && { errorCode: data.errorCode }),
        ...(data.errorDetail !== undefined && {
          errorDetail: data.errorDetail,
        }),
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

  // bm08-spec §Design/§Implementation §1 — the rerun candidate read: every
  // account scoped into the run with its current status and attempt counter, so
  // the rerun service can resolve the eligible set (drop `EXCLUDED` and, via a
  // separate posted-bill check, any finalized account) and compute the next
  // attempt number. Ordered by account id for a stable, deterministic set.
  async listForRerun(
    tx: Database,
    billRunId: string,
  ): Promise<
    { billingAccountId: string; status: AccountStatus; attemptCount: number }[]
  > {
    const rows = await tx
      .select({
        billingAccountId: billRunAccount.refBillingAccountId,
        status: billRunAccount.status,
        attemptCount: billRunAccount.attemptCount,
      })
      .from(billRunAccount)
      .where(eq(billRunAccount.refBillRunId, billRunId))
      .orderBy(billRunAccount.refBillingAccountId);
    return rows.map((r) => ({ ...r, status: r.status as AccountStatus }));
  },

  // bm08-spec §Design/§Implementation §1 (step 2) — the rerun advance: bump
  // `attempt_count` (so the attempt-keyed `bill_run_account_stage` latch makes
  // every new-attempt signal land on a fresh row from the chosen stage onward,
  // never colliding with the prior attempt's history) and drop the selected
  // accounts back to `PROCESSING`, clearing any prior failure diagnostics.
  // Scoped strictly to the passed account ids — no other account is touched.
  async incrementAttemptForRerun(
    tx: Database,
    billRunId: string,
    billingAccountIds: string[],
  ): Promise<void> {
    if (billingAccountIds.length === 0) return;
    await tx
      .update(billRunAccount)
      .set({
        attemptCount: sql`${billRunAccount.attemptCount} + 1`,
        status: "PROCESSING",
        errorCode: null,
        errorDetail: null,
        lastProcessedAt: new Date(),
      })
      .where(
        and(
          eq(billRunAccount.refBillRunId, billRunId),
          inArray(billRunAccount.refBillingAccountId, billingAccountIds),
        ),
      );
  },

  // bm07-spec §Design/§2 — the Uncharged tab read: the run's deliberately-not-
  // billed accounts (`status = 'EXCLUDED'`, a scoping-time partial-period
  // exclusion), joined to the account name/financial-account (for the deep
  // link) and the run period (the uncharged window). No money — the indicative
  // value has no source in v1. Ordered by account name for a stable list.
  async listExcludedForRun(
    db: Database,
    billRunId: string,
  ): Promise<
    {
      billingAccountId: string;
      financialAccountId: string;
      accountName: string;
      reason: string | null;
      windowStart: string;
      windowEnd: string;
    }[]
  > {
    return db
      .select({
        billingAccountId: billRunAccount.refBillingAccountId,
        financialAccountId: billingAccount.refFinancialAccountId,
        accountName: billingAccount.name,
        reason: billRunAccount.errorCode,
        windowStart: billRun.periodStart,
        windowEnd: billRun.periodEnd,
      })
      .from(billRunAccount)
      .innerJoin(
        billingAccount,
        eq(billRunAccount.refBillingAccountId, billingAccount.billingAccountId),
      )
      .innerJoin(billRun, eq(billRunAccount.refBillRunId, billRun.billRunId))
      .where(
        and(
          eq(billRunAccount.refBillRunId, billRunId),
          eq(billRunAccount.status, "EXCLUDED"),
        ),
      )
      .orderBy(billingAccount.name);
  },

  // bm07-spec §Design/§2 — the Errors tab read: the run's blocking failures
  // (`status = 'PROCESSING_FAILED'`), each joined to its latest-attempt `HARD`
  // `bill_run_account_stage` row (the stage/code/detail that blocked it).
  // `DISTINCT ON (account) ORDER BY ... attempt DESC, stage_id DESC` picks the
  // most recent HARD row Postgres-side — the `stage_id DESC` tiebreaker keeps
  // the pick deterministic when an account has HARD rows on two stages at the
  // same `attempt` number (the per-stage attempt counters can collide); the
  // sequence-assigned `bill_run_account_stage_id` is monotonic, so the highest
  // id is the last-recorded failure. The inner join to a HARD stage row keeps
  // only genuinely-blocked accounts.
  async listErrorsForRun(
    db: Database,
    billRunId: string,
  ): Promise<
    {
      billingAccountId: string;
      accountName: string;
      stage: Stage;
      errorClass: ErrorClass;
      errorCode: string | null;
      errorDetail: string | null;
    }[]
  > {
    const rows = await db
      .selectDistinctOn([billRunAccountStage.refBillingAccountId], {
        billingAccountId: billRunAccountStage.refBillingAccountId,
        accountName: billingAccount.name,
        stage: billRunAccountStage.stage,
        errorClass: billRunAccountStage.errorClass,
        errorCode: billRunAccountStage.errorCode,
        errorDetail: billRunAccountStage.errorDetail,
      })
      .from(billRunAccountStage)
      .innerJoin(
        billRunAccount,
        and(
          eq(billRunAccountStage.refBillRunId, billRunAccount.refBillRunId),
          eq(
            billRunAccountStage.refBillingAccountId,
            billRunAccount.refBillingAccountId,
          ),
        ),
      )
      .innerJoin(
        billingAccount,
        eq(
          billRunAccountStage.refBillingAccountId,
          billingAccount.billingAccountId,
        ),
      )
      .where(
        and(
          eq(billRunAccountStage.refBillRunId, billRunId),
          eq(billRunAccountStage.errorClass, "HARD"),
          eq(billRunAccount.status, "PROCESSING_FAILED"),
        ),
      )
      .orderBy(
        billRunAccountStage.refBillingAccountId,
        desc(billRunAccountStage.attempt),
        desc(billRunAccountStage.billRunAccountStageId),
      );
    return rows.map((r) => ({
      ...r,
      stage: r.stage as Stage,
      errorClass: r.errorClass as ErrorClass,
    }));
  },
};
