import { and, eq, not, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { document } from "@/db/schema/billing/documents";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { openReceivable } from "@/services/accounts/money";
import { resolveTerm } from "@/services/accounts/term-resolution";
import type {
  BillingAccount,
  BillCycle,
  PaymentStatus,
} from "@/types/accounts";

export type BillingAccountDetail = {
  ban: BillingAccount;
  billCycle: BillCycle;
  receivableBalance: string;
  paymentStatus: PaymentStatus;
  derivedOverdue: boolean;
};

// Pure derivation — tested independently (ac05-spec §3.6 overdue unit test).
// openARSen: positive = we're owed money; earliestOpenChargeDate: when the
// oldest unpaid charge was issued; paymentDueDays: resolved term (override ??
// cycle default). Returns true only when all three conditions hold.
export function deriveOverdue(
  openARSen: bigint,
  earliestOpenChargeDate: Date | null,
  paymentDueDays: number,
  now: Date = new Date(),
): boolean {
  if (openARSen <= 0n) return false;
  if (earliestOpenChargeDate === null) return false;
  const dueDate = new Date(earliestOpenChargeDate);
  dueDate.setDate(dueDate.getDate() + paymentDueDays);
  return now > dueDate;
}

// Finds the event_at of the earliest DBN that is still open (not reversed /
// cancelled). Returns null when no such document exists (no open charges →
// overdue is always false). Posting is ac07, so this returns null until
// documents are created.
async function findEarliestOpenChargeDate(banId: string): Promise<Date | null> {
  const [row] = await db
    .select({ eventAt: document.eventAt })
    .from(document)
    .where(
      and(
        eq(document.refBillingAccountId, banId),
        eq(document.docType, "DBN"),
        not(inArray(document.state, ["reversed", "cancelled"])),
      ),
    )
    .orderBy(document.eventAt)
    .limit(1);

  return row?.eventAt ?? null;
}

// Reads BAN base fields, bill cycle, live A/R, and derived overdue flag
// (ac05-spec §2.5 / §3.4). Balance is a live read (Module Inv. #2).
export async function getBillingAccountDetail(
  banId: string,
): Promise<BillingAccountDetail | null> {
  const ban = await billingAccountRepository.findById(db, banId);
  if (!ban) return null;

  const billCycle = await billCycleRepository.findById(db, ban.refBillCycleId);
  if (!billCycle) throw new Error(`bill cycle ${ban.refBillCycleId} not found`);

  const banBindings = await ledgerBindingRepository.findByOwner(
    db,
    "billing_account",
    banId,
  );
  const recBinding = banBindings.find((b) => b.ledgerRole === "receivables");

  const receivableBalance = recBinding
    ? await ledgerRepository.balanceByLedgerAccountId(
        db,
        recBinding.pgledgerAccountId,
      )
    : "0.00";

  const openARSen = openReceivable(receivableBalance);
  const earliestChargeDate =
    openARSen > 0n ? await findEarliestOpenChargeDate(banId) : null;

  const term = resolveTerm(
    ban.paymentDueDaysOverride ?? null,
    billCycle.paymentDueDays,
  );
  const derivedOverdue = deriveOverdue(openARSen, earliestChargeDate, term);

  return {
    ban,
    billCycle,
    receivableBalance,
    paymentStatus: ban.paymentStatus as PaymentStatus,
    derivedOverdue,
  };
}
