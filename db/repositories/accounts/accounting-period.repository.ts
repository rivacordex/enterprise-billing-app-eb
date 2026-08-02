import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { accountingPeriod } from "@/db/schema/billing/periods";
import type { AccountingPeriod } from "@/db/schema/billing/periods";

export const accountingPeriodRepository = {
  async findByPeriodAndCurrency(
    db: Database,
    period: string,
    currency: string,
  ): Promise<AccountingPeriod | null> {
    const [row] = await db
      .select()
      .from(accountingPeriod)
      .where(
        and(
          eq(accountingPeriod.period, period),
          eq(accountingPeriod.currency, currency),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // ac14-spec §3.1/§3.6 — close an accounting period. If no row exists, lazily
  // creates it as closed (spec §2.1: "closing creates-then-closes"). If the row
  // is already closed, returns 'already_closed' (idempotent — no second audit).
  //
  // Concurrency: SELECT FOR UPDATE serialises concurrent closes when a row
  // already exists. For the absent-row case, INSERT ... ON CONFLICT DO NOTHING
  // prevents a unique-violation when two transactions race to create the first
  // closed row — the loser receives 0 inserted rows and returns 'already_closed'.
  async close(
    tx: Database,
    period: string,
    currency: string,
    actorId: string,
  ): Promise<"closed" | "already_closed"> {
    const [existing] = await tx
      .select()
      .from(accountingPeriod)
      .where(
        and(
          eq(accountingPeriod.period, period),
          eq(accountingPeriod.currency, currency),
        ),
      )
      .for("update")
      .limit(1);

    if (existing?.state === "closed") return "already_closed";

    const now = new Date();

    if (existing) {
      await tx
        .update(accountingPeriod)
        .set({
          state: "closed",
          closedAt: now,
          closedBy: actorId,
          lastModified: now,
          lastEditedBy: actorId,
        })
        .where(
          and(
            eq(accountingPeriod.period, period),
            eq(accountingPeriod.currency, currency),
          ),
        );
    } else {
      const inserted = await tx
        .insert(accountingPeriod)
        .values({
          period,
          currency,
          state: "closed",
          closedAt: now,
          closedBy: actorId,
          lastEditedBy: actorId,
        })
        .onConflictDoNothing()
        .returning({ state: accountingPeriod.state });

      if (inserted.length === 0) return "already_closed";
    }

    return "closed";
  },
};
