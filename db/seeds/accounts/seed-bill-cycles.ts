import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { logger } from "@/lib/logger";
import { billCycle } from "@/db/schema/billing/catalogs";

interface BillCycleSeed {
  name: string;
  cycleDay: number;
  paymentDueDays: number;
}

// Two bill cycles (ac03-spec §2.6, Q13). `bill_cycle_id` is DB-generated
// (`BCY` + sequence) — the caller reads the default cycle's id back off the
// insert/lookup rather than assuming `BCY000001`, so the wizard-defaults
// config row (seed-wizard-defaults.ts) is correct even if this seed runs
// after some other insert has already consumed the sequence.
const BILL_CYCLE_SEEDS: BillCycleSeed[] = [
  { name: "Monthly – Day 1", cycleDay: 1, paymentDueDays: 30 },
  { name: "Monthly – Day 15", cycleDay: 15, paymentDueDays: 30 },
];

const DEFAULT_BILL_CYCLE_NAME = "Monthly – Day 1";

export async function seedBillCycles(
  tx: Database,
): Promise<{ defaultBillCycleId: string }> {
  let defaultBillCycleId: string | null = null;

  for (const seed of BILL_CYCLE_SEEDS) {
    const [existing] = await tx
      .select({ billCycleId: billCycle.billCycleId })
      .from(billCycle)
      .where(eq(billCycle.name, seed.name))
      .limit(1);

    let billCycleId: string;
    if (existing) {
      billCycleId = existing.billCycleId;
    } else {
      const [inserted] = await tx
        .insert(billCycle)
        .values({
          name: seed.name,
          cycleDay: seed.cycleDay,
          paymentDueDays: seed.paymentDueDays,
          lastEditedBy: null,
        })
        .returning({ billCycleId: billCycle.billCycleId });
      if (!inserted) {
        throw new Error(`Bill cycle '${seed.name}' was not inserted.`);
      }
      billCycleId = inserted.billCycleId;
    }

    if (seed.name === DEFAULT_BILL_CYCLE_NAME) {
      defaultBillCycleId = billCycleId;
    }
  }

  if (!defaultBillCycleId) {
    throw new Error(
      `Default bill cycle '${DEFAULT_BILL_CYCLE_NAME}' was not seeded.`,
    );
  }

  logger.info("Bill cycles seeded.", { count: BILL_CYCLE_SEEDS.length });
  return { defaultBillCycleId };
}
