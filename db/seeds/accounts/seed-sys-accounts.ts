import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { logger } from "@/lib/logger";

// One sys pgledger account per posting nature that needs a counter-account
// (architecture §3, Q19). Deposit legs steer to sys.cash — no separate
// sys.deposit_movement account (ac03-spec §2.2).
const SYS_ACCOUNT_NAMES = [
  "sys.cash.MYR",
  "sys.revenue.MYR",
  "sys.revenue_adj.MYR",
  "sys.write_off.MYR",
  "sys.rounding.MYR",
  "sys.tax_payable.MYR",
] as const;

export async function seedSysAccounts(db: Database): Promise<void> {
  // pgledger_accounts.name has no UNIQUE constraint, so the check-then-create
  // loop below is only race-free if concurrent seed runs are serialized.
  // A transaction-scoped advisory lock does that: it's acquired once per
  // `db:seed-accounts` invocation (this function runs inside the seed's
  // single transaction, seed-accounts.ts) and auto-releases on commit or
  // rollback, so a second concurrent run blocks here instead of racing the
  // pre-check and creating a duplicate `sys.*` account.
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('billing.seed_sys_accounts'))`,
  );

  for (const name of SYS_ACCOUNT_NAMES) {
    const existing = await ledgerRepository.findByName(db, name);
    if (existing) {
      logger.info(`sys account already exists, skipping: ${name}`);
      continue;
    }
    await ledgerRepository.createAccount(db, name, "MYR");
    logger.info(`created sys account: ${name}`);
  }
}
