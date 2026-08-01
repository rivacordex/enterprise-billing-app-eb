import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billCycle } from "@/db/schema/billing/catalogs";
import { logger } from "@/lib/logger";

interface BillCycleEntry {
  name: string;
  cycleDay: number;
  paymentDueDays: number;
}

export const DEFAULT_BILL_CYCLE_NAME = "Monthly – Day 1";

// Spec §2.6 / plan §2. Two bill cycles for the MYR Q2 wizard.
const BILL_CYCLE_ENTRIES: BillCycleEntry[] = [
  { name: DEFAULT_BILL_CYCLE_NAME, cycleDay: 1, paymentDueDays: 30 },
  { name: "Monthly – Day 15", cycleDay: 15, paymentDueDays: 30 },
];

export async function seedBillCycles(
  db: Database,
): Promise<{ defaultCycleId: string }> {
  let defaultCycleId: string | null = null;

  for (const entry of BILL_CYCLE_ENTRIES) {
    const [existing] = await db
      .select({ billCycleId: billCycle.billCycleId })
      .from(billCycle)
      .where(eq(billCycle.name, entry.name))
      .limit(1);

    if (existing) {
      logger.info(`bill_cycle already exists, skipping: ${entry.name}`);
      if (entry.cycleDay === 1) {
        defaultCycleId = existing.billCycleId;
      }
      continue;
    }

    const [inserted] = await db
      .insert(billCycle)
      .values({
        name: entry.name,
        frequency: "monthly",
        cycleDay: entry.cycleDay,
        paymentDueDays: entry.paymentDueDays,
        state: "active",
        lastEditedBy: null,
      })
      .returning({ billCycleId: billCycle.billCycleId });

    if (!inserted) {
      throw new Error(`bill_cycle insert returned no row for '${entry.name}'`);
    }

    logger.info(`created bill_cycle: ${entry.name} (${inserted.billCycleId})`);

    if (entry.cycleDay === 1) {
      defaultCycleId = inserted.billCycleId;
    }
  }

  if (!defaultCycleId) {
    throw new Error(
      "seedBillCycles: could not determine default bill cycle id",
    );
  }

  return { defaultCycleId };
}
