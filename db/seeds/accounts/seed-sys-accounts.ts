import type { Database } from "@/db/client";
import { logger } from "@/lib/logger";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";

// Six `sys.{nature}.MYR` pgledger accounts (ac03-spec §2.2, Q19) — one per
// posting nature that needs a counter-account, plus cash/tax. No
// `sys.deposit_movement` account: deposit legs move between `sys.cash` and
// the FA `deposits`/`unapplied_cash` accounts (Q16); `deposit_movement` only
// labels reason codes and steers their cash leg to `sys.cash` (§2.2 note).
// Sys accounts get no `ledger_binding` row — they resolve via
// `gl_resolution_view`'s `system_account` selector, matched on name, not a
// binding role.
export const SYS_ACCOUNT_NAMES = [
  "sys.cash.MYR",
  "sys.revenue.MYR",
  "sys.revenue_adj.MYR",
  "sys.write_off.MYR",
  "sys.rounding.MYR",
  "sys.tax_payable.MYR",
] as const;

export async function seedSysAccounts(tx: Database): Promise<void> {
  for (const name of SYS_ACCOUNT_NAMES) {
    const existing = await ledgerRepository.findByName(tx, name);
    if (existing) {
      continue;
    }
    // Defaults (allow_negative_balance/allow_positive_balance = true) so
    // credit-normal sys accounts go negative freely (ac01 §2.4, §2.2).
    await ledgerRepository.createAccount(tx, { name, currency: "MYR" });
  }
  logger.info("Sys ledger accounts seeded.", {
    count: SYS_ACCOUNT_NAMES.length,
  });
}
