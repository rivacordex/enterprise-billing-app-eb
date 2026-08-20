import type { Database } from "@/db/client";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { notFound } from "@/lib/errors";
import { senToString } from "@/services/accounts/money";
import { resolveTerm } from "@/services/accounts/term-resolution";
import { addDays, firstOfMonth } from "@/services/billing/derive-periods";

// bm05-spec §Design/§Implementation §4. Aggregation (stage 4) — for a
// validated, non-EXCLUDED account, write one trial `customer_bill`:
// `category: 'trial'`, `state: 'new'`, the run's period as the billing
// period, `payment_due_date` = the run date (`scheduled_run_date`, the v1
// `entry_date`) plus the resolved payment-term days (the same
// `coalesce(account override, cycle default)` resolution Validation already
// uses, `resolveTerm`/`validate-account.ts`). Money stays `numeric(18,2)`/
// `string`, computed via the platform decimal helper
// (`services/accounts/money.ts`) — never JS float (code-standards §2.3).
//
// v1 has no `rating` table, so `subtotal` is a **deterministic synthetic
// stub** — a stable function of `billing_account_id` alone, no randomness —
// so reruns and tests are stable (spec §Resolved). `tax_total` stays
// "0.00"/`total_amount` = `subtotal` in v1: taxation is bm06's stage, not
// computed here. Rerun-safe: the write is a conditional
// `DELETE ... WHERE ref_inv_document_id IS NULL` + INSERT, keyed on
// (run, ban) — a bill already carrying `ref_inv_document_id` (posted) is
// never touched (architecture Inv. #4).

const STUB_BASE_SEN = 10_000n; // 100.00 base
const STUB_PER_BAN_INCREMENT_SEN = 750n; // 7.50 per BAN-suffix unit
const STUB_SUFFIX_MODULUS = 1000n;

// Exported for direct unit testing — pure, stable across reruns.
export function deriveStubSubtotal(billingAccountId: string): string {
  const digits = billingAccountId.replace(/\D/g, "");
  const suffix = digits.length > 0 ? BigInt(digits) % STUB_SUFFIX_MODULUS : 0n;
  return senToString(STUB_BASE_SEN + suffix * STUB_PER_BAN_INCREMENT_SEN);
}

export interface AggregateBillRun {
  billRunId: string;
  periodStart: string;
  periodEnd: string;
  scheduledRunDate: string;
}

export async function aggregateBill(
  tx: Database,
  run: AggregateBillRun,
  billingAccountId: string,
): Promise<void> {
  const account = await billingAccountRepository.findById(tx, billingAccountId);
  if (!account) {
    throw notFound(
      `Billing account ${billingAccountId} could not be resolved.`,
    );
  }

  const cycle = await billCycleRepository.findById(tx, account.refBillCycleId);
  if (!cycle) {
    throw notFound(
      `Bill cycle ${account.refBillCycleId} could not be resolved for account ${billingAccountId}.`,
    );
  }

  const termDays = resolveTerm(
    account.paymentDueDaysOverride ?? null,
    cycle.paymentDueDays,
  );
  const paymentDueDate = addDays(run.scheduledRunDate, termDays);
  const periodPartition = firstOfMonth(run.periodStart);
  const subtotal = deriveStubSubtotal(billingAccountId);

  await customerBillRepository.deleteTrial(tx, run.billRunId, billingAccountId);
  await customerBillRepository.insertTrial(tx, {
    refBillRunId: run.billRunId,
    refBillingAccountId: billingAccountId,
    periodPartition,
    category: "trial",
    state: "new",
    billingPeriodStart: run.periodStart,
    billingPeriodEnd: run.periodEnd,
    subtotal,
    taxTotal: "0.00",
    totalAmount: subtotal,
    paymentDueDate,
  });
}
