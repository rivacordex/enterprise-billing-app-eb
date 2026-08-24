import { and, eq, ne, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billingAccount } from "@/db/schema/billing/accounts";
import type {
  BillingAccount,
  BillingAccountInsert,
} from "@/db/schema/billing/accounts";

export const billingAccountRepository = {
  async findById(
    db: Database,
    billingAccountId: string,
  ): Promise<BillingAccount | null> {
    const [row] = await db
      .select()
      .from(billingAccount)
      .where(eq(billingAccount.billingAccountId, billingAccountId))
      .limit(1);
    return row ?? null;
  },

  async insert(
    tx: Database,
    data: BillingAccountInsert,
  ): Promise<BillingAccount> {
    const [row] = await tx.insert(billingAccount).values(data).returning();
    if (!row) throw new Error("billing_account insert returned no row");
    return row;
  },

  // The `payment_status` write path (ac07-spec §2.7, V8) — flips between
  // `paid`/`due` on allocation posting. `overdue` is never written here; it
  // stays a read-time derivation (Q8, ac05's badge).
  async updatePaymentStatus(
    tx: Database,
    billingAccountId: string,
    paymentStatus: "paid" | "due",
  ): Promise<void> {
    await tx
      .update(billingAccount)
      .set({ paymentStatus })
      .where(eq(billingAccount.billingAccountId, billingAccountId));
  },

  // ac16-spec §2.1 — every BAN owned by a given FA, for the FA closure gate
  // (all BANs must be `closed`) and the FA detail page's BAN selector.
  async findByFinancialAccountId(
    db: Database,
    financialAccountId: string,
  ): Promise<BillingAccount[]> {
    return db
      .select()
      .from(billingAccount)
      .where(eq(billingAccount.refFinancialAccountId, financialAccountId))
      .orderBy(billingAccount.billingAccountId);
  },

  // ac16-spec §2.1/§3.1/§3.2 — closure CAS write: same four-outcome pattern
  // as `financialAccountRepository.close` / the catalog `retire` precedent.
  async close(
    db: Database,
    billingAccountId: string,
    lastModified: Date,
  ): Promise<"updated" | "conflict" | "already_closed" | "not_found"> {
    const [updated] = await db
      .update(billingAccount)
      .set({ state: "closed", lastModified: sql`now()` })
      .where(
        and(
          eq(billingAccount.billingAccountId, billingAccountId),
          eq(billingAccount.lastModified, lastModified),
          ne(billingAccount.state, "closed"),
        ),
      )
      .returning();

    if (updated) return "updated";

    const [current] = await db
      .select()
      .from(billingAccount)
      .where(eq(billingAccount.billingAccountId, billingAccountId))
      .limit(1);
    if (!current) return "not_found";
    if (current.state === "closed") return "already_closed";
    return "conflict";
  },

  // Disclosed additive method (pm28-spec §Design, ac04/pm16 locking
  // precedent) — a single-row `FOR UPDATE` finder for the ordering module's
  // in-transaction TOCTOU re-check of the BAN's state (Q15), owning party
  // (mismatch guard), and currency (override currency gate). No join, so
  // `FOR UPDATE` is legal here.
  async findStateByIdForUpdate(
    tx: Database,
    billingAccountId: string,
  ): Promise<{
    state: string;
    refPartyRoleId: string;
    currency: string;
  } | null> {
    const [row] = await tx
      .select({
        state: billingAccount.state,
        refPartyRoleId: billingAccount.refPartyRoleId,
        currency: billingAccount.currency,
      })
      .from(billingAccount)
      .where(eq(billingAccount.billingAccountId, billingAccountId))
      .for("update")
      .limit(1);
    return row ?? null;
  },

  // bm03-spec §Design — the scoping snapshot source: every `active` billing
  // account under a cycle, no `rating_type`/`payment_status` filter in v1
  // (resolved decision #1).
  async findActiveByCycleId(
    db: Database,
    refBillCycleId: string,
  ): Promise<Pick<BillingAccount, "billingAccountId">[]> {
    return db
      .select({ billingAccountId: billingAccount.billingAccountId })
      .from(billingAccount)
      .where(
        and(
          eq(billingAccount.refBillCycleId, refBillCycleId),
          eq(billingAccount.state, "active"),
        ),
      )
      .orderBy(billingAccount.billingAccountId);
  },

  // bm12-spec §Design/§Implementation §6 — the re-trigger period-close guard
  // needs the run's settlement currency, but `bill_run` stores none: a cycle is
  // single-currency in v1 (the same invariant `findActiveForPeriod` relies on),
  // so the first active account's currency is the run's currency. Returns null
  // when the cycle has no active accounts (the re-trigger then falls through to
  // the existing NO_ELIGIBLE_ACCOUNTS path).
  async findCurrencyByCycleId(
    db: Database,
    refBillCycleId: string,
  ): Promise<string | null> {
    const [row] = await db
      .select({ currency: billingAccount.currency })
      .from(billingAccount)
      .where(
        and(
          eq(billingAccount.refBillCycleId, refBillCycleId),
          eq(billingAccount.state, "active"),
        ),
      )
      .orderBy(billingAccount.billingAccountId)
      .limit(1);
    return row?.currency ?? null;
  },
};
