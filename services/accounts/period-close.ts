// ac14-spec §3.1 — period close service. Marks an accounting_period row as
// closed, lazily creating it if it doesn't exist yet (spec §2.1). Audits
// PERIOD_CLOSED in the same transaction. No reopening (Q9, Inv. #7).

import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { accountingPeriodRepository } from "@/db/repositories/accounts/accounting-period.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";

export type ClosePeriodResult =
  | { ok: true }
  | { ok: false; code: "ALREADY_CLOSED" }
  | { ok: false; code: "BILL_RUN_IN_PROGRESS"; activeRunIds: string[] };

export async function closePeriod(
  period: string,
  currency: string,
  actorId: string,
): Promise<ClosePeriodResult> {
  return db.transaction(async (tx) => {
    // bm09-spec §Design/§Implementation §4 — refuse to close a period while a
    // bill_run is still posting INVs into it. Checked before the accounting
    // period is touched at all.
    const activeRunIds = await billRunRepository.findActiveForPeriod(
      tx,
      period,
      currency,
    );
    if (activeRunIds.length > 0) {
      return {
        ok: false,
        code: "BILL_RUN_IN_PROGRESS",
        activeRunIds,
      } as const;
    }

    const outcome = await accountingPeriodRepository.close(
      tx,
      period,
      currency,
      actorId,
    );

    if (outcome === "already_closed") {
      return { ok: false, code: "ALREADY_CLOSED" } as const;
    }

    await insertAuditEvent(tx, {
      eventType: "PERIOD_CLOSED",
      actorUserId: actorId,
      targetEntity: "ACCOUNTING_PERIOD",
      targetId: `${period}/${currency}`,
      beforeData: null,
      afterData: { period, currency },
    });

    return { ok: true } as const;
  });
}

// Read-only helper: returns 'open' for an absent period row (spec §2.1 —
// periods exist lazily; absence means open until first close).
export async function getPeriodState(
  period: string,
  currency: string,
): Promise<"open" | "closed"> {
  const row = await accountingPeriodRepository.findByPeriodAndCurrency(
    db,
    period,
    currency,
  );
  return row?.state === "closed" ? "closed" : "open";
}
