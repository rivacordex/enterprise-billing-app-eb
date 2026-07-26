import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { logger } from "@/lib/logger";
import { reasonCode } from "@/db/schema/billing/catalogs";

interface ReasonCodeSeed {
  reasonCode: string;
  name: string;
  docType: "PAY" | "DEP" | "CRN" | "DBN" | "ADJ";
  postingNature:
    | "revenue"
    | "revenue_adj"
    | "write_off"
    | "rounding"
    | "cash"
    | "deposit_movement";
  autoPostLimit: string;
}

// Ten reason codes (ac03-spec §2.5, Q19/Q20) — `auto_post_limit = '0'` means
// always four-eyes (never auto-posts): PAYMENT_REFUND, DEP_REVERSE,
// DEP_REFUND, BAD_DEBT_WRITEOFF. §2.5's prose says "Nine rows" but its own
// table lists ten and the V5 test/checklist (§3.3/§5) both assert ten —
// treated as a spec typo, not a content gap.
const REASON_CODE_SEEDS: ReasonCodeSeed[] = [
  {
    reasonCode: "CUST_PAYMENT",
    name: "Customer Payment",
    docType: "PAY",
    postingNature: "cash",
    autoPostLimit: "100000.00",
  },
  {
    reasonCode: "ADVANCE_PAYMENT",
    name: "Advance Payment",
    docType: "PAY",
    postingNature: "cash",
    autoPostLimit: "100000.00",
  },
  {
    reasonCode: "PAYMENT_REFUND",
    name: "Payment Refund",
    docType: "PAY",
    postingNature: "cash",
    autoPostLimit: "0",
  },
  {
    reasonCode: "SEC_DEPOSIT",
    name: "Security Deposit",
    docType: "DEP",
    postingNature: "deposit_movement",
    autoPostLimit: "50000.00",
  },
  {
    reasonCode: "DEP_REVERSE",
    name: "Deposit Reversal",
    docType: "DEP",
    postingNature: "deposit_movement",
    autoPostLimit: "0",
  },
  {
    reasonCode: "DEP_REFUND",
    name: "Deposit Refund",
    docType: "DEP",
    postingNature: "deposit_movement",
    autoPostLimit: "0",
  },
  {
    reasonCode: "GOODWILL_CREDIT",
    name: "Goodwill Credit",
    docType: "CRN",
    postingNature: "revenue_adj",
    autoPostLimit: "1000.00",
  },
  {
    reasonCode: "MANUAL_CHARGE",
    name: "Manual Charge",
    docType: "DBN",
    postingNature: "revenue",
    autoPostLimit: "10000.00",
  },
  {
    reasonCode: "BAD_DEBT_WRITEOFF",
    name: "Bad Debt Write-off",
    docType: "ADJ",
    postingNature: "write_off",
    autoPostLimit: "0",
  },
  {
    reasonCode: "ROUNDING_ADJ",
    name: "Rounding Adjustment",
    docType: "ADJ",
    postingNature: "rounding",
    autoPostLimit: "10.00",
  },
];

export async function seedReasonCodes(tx: Database): Promise<void> {
  for (const seed of REASON_CODE_SEEDS) {
    const [existing] = await tx
      .select({ reasonCode: reasonCode.reasonCode })
      .from(reasonCode)
      .where(eq(reasonCode.reasonCode, seed.reasonCode))
      .limit(1);
    if (existing) {
      continue;
    }
    await tx.insert(reasonCode).values({
      reasonCode: seed.reasonCode,
      name: seed.name,
      docType: seed.docType,
      postingNature: seed.postingNature,
      autoPostLimit: seed.autoPostLimit,
      lastEditedBy: null,
    });
  }
  logger.info("Reason codes seeded.", { count: REASON_CODE_SEEDS.length });
}
