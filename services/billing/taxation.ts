import type { Database } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { customerBillTaxItemRepository } from "@/db/repositories/billing/customer-bill-tax-item.repository";
import { billRunTaxConfig } from "@/lib/config";

// bm06-spec §Design/§Implementation §3. The Taxation stage (stage 6) applies
// the run's tax-rate version — a single CONFIGURED SST rate in v1
// (`billRunTaxConfig`, no catalog table) — to an account's trial bill:
//
//   1. resolve the run's UNPOSTED bill for the account (the
//      `ref_inv_document_id IS NULL` finalization latch, architecture Inv. #4);
//      no bill yet (aggregation hasn't run / the account was scoped out) ⇒
//      nothing to tax, a clean no-op;
//   2. stamp `bill_run.ref_tax_rate_version` if still null (idempotent, uniform
//      per run — provenance);
//   3. rerun-safely replace the bill's tax items (DELETE + INSERT), computing
//      `tax_amount = round(subtotal * rate / 100, 2)` in SQL `numeric`; then
//   4. recompute `tax_total` (the SQL SUM of the items) and
//      `total_amount = subtotal + tax_total`, again in SQL.
//
// Framework-agnostic (`tx`, no `next/*`); called only from the stage-signal
// ingest (`handle-stage-signal.ts`) inside its transaction. Deterministic: the
// bm05 stub subtotal is deterministic, so the tax is too. Never touches a
// posted bill (every write is latch-guarded).

export interface TaxBillRun {
  billRunId: string;
}

export async function taxBill(
  tx: Database,
  run: TaxBillRun,
  billingAccountId: string,
): Promise<void> {
  const bill = await customerBillRepository.findUnpostedBill(
    tx,
    run.billRunId,
    billingAccountId,
  );
  // No unposted trial bill for this account — aggregation hasn't produced one
  // (or the only bill is already posted). Nothing to tax; leave the run's
  // version stamp untouched.
  if (!bill) return;

  await billRunRepository.stampTaxRateVersion(
    tx,
    run.billRunId,
    billRunTaxConfig.version,
  );

  await customerBillTaxItemRepository.replaceForBill(tx, {
    customerBillId: bill.customerBillId,
    periodPartition: bill.periodPartition,
    category: billRunTaxConfig.category,
    rate: billRunTaxConfig.rate,
  });

  await customerBillRepository.recomputeTotals(
    tx,
    bill.customerBillId,
    bill.periodPartition,
  );
}
