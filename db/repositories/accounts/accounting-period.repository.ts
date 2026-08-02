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
      await tx.insert(accountingPeriod).values({
        period,
        currency,
        state: "closed",
        closedAt: now,
        closedBy: actorId,
        lastEditedBy: actorId,
      });
    }

    return "closed";
  },
};
