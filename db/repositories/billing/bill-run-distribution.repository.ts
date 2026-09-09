import { and, desc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billRunDistribution } from "@/db/schema/billing/bill-run-distribution";
import type { BillRunDistributionInsert } from "@/db/schema/billing/bill-run-distribution";
import type {
  DistributionArtifactType,
  DistributionOutcome,
} from "@/types/billing";

// bm20-spec §Implementation §1. Insert-first idempotency (mirrors
// `bill_run_account_stage_repository.insertStageRow`) + the two read models:
// the delivery log (`DistributionTab`) and the failed-artifact set
// (`rerunDistribution`/`forceCompleteDistribution`).
export const billRunDistributionRepository = {
  async insertOutcome(
    db: Database,
    data: BillRunDistributionInsert,
  ): Promise<{ billRunDistributionId: string }> {
    const [row] = await db.insert(billRunDistribution).values(data).returning({
      billRunDistributionId: billRunDistribution.billRunDistributionId,
    });
    if (!row) {
      throw new Error(
        "bill-run-distribution.repository.insertOutcome: no row returned",
      );
    }
    return row;
  },

  // The full delivery log across every round — `DistributionTab`'s read
  // model (bm20-spec §Visual — the per-artifact delivery log), newest first.
  async listForRun(
    db: Database,
    billRunId: string,
  ): Promise<
    {
      billRunDistributionId: string;
      target: string;
      artifactRef: string;
      artifactType: DistributionArtifactType;
      isMandatory: boolean;
      outcome: DistributionOutcome;
      at: Date;
      distributionAttempt: number;
    }[]
  > {
    const rows = await db
      .select()
      .from(billRunDistribution)
      .where(eq(billRunDistribution.refBillRunId, billRunId))
      .orderBy(desc(billRunDistribution.at));
    return rows.map((r) => ({
      billRunDistributionId: r.billRunDistributionId,
      target: r.target,
      artifactRef: r.artifactRef,
      artifactType: r.artifactType as DistributionArtifactType,
      isMandatory: r.isMandatory,
      outcome: r.outcome as DistributionOutcome,
      at: r.at,
      distributionAttempt: r.distributionAttempt,
    }));
  },

  // The FAILED artifacts of the given round — `rerunDistribution`'s
  // redelivery set and `forceCompleteDistribution`'s abandoned-artifact list
  // (bm20-spec §Implementation §3/T11).
  async listFailedForAttempt(
    db: Database,
    billRunId: string,
    distributionAttempt: number,
  ): Promise<
    {
      target: string;
      artifactRef: string;
      artifactType: DistributionArtifactType;
      isMandatory: boolean;
    }[]
  > {
    const rows = await db
      .select({
        target: billRunDistribution.target,
        artifactRef: billRunDistribution.artifactRef,
        artifactType: billRunDistribution.artifactType,
        isMandatory: billRunDistribution.isMandatory,
      })
      .from(billRunDistribution)
      .where(
        and(
          eq(billRunDistribution.refBillRunId, billRunId),
          eq(billRunDistribution.distributionAttempt, distributionAttempt),
          eq(billRunDistribution.outcome, "FAILED"),
        ),
      );
    return rows.map((r) => ({
      ...r,
      artifactType: r.artifactType as DistributionArtifactType,
    }));
  },
};
