import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
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
  for (const name of SYS_ACCOUNT_NAMES) {
    const existing = await db.execute<{ id: string }>(
      sql`SELECT id FROM billing.pgledger_accounts_view WHERE name = ${name} LIMIT 1`,
    );
    if (existing.length > 0) {
      logger.info(`sys account already exists, skipping: ${name}`);
      continue;
    }
    await db.execute(
      sql`SELECT id FROM billing.pgledger_create_account(${name}, ${"MYR"})`,
    );
    logger.info(`created sys account: ${name}`);
  }
}
