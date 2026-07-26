import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { reasonCode } from "@/db/schema/billing/catalogs";
import { logger } from "@/lib/logger";

interface ReasonCodeEntry {
  reasonCode: string;
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

// Spec §2.5 / plan §2. Sensitive natures (refunds, reversals, write-offs)
// seeded at limit 0 — always four-eyes (Q20).
const REASON_CODE_ENTRIES: ReasonCodeEntry[] = [
  {
    reasonCode: "CUST_PAYMENT",
    docType: "PAY",
    postingNature: "cash",
    autoPostLimit: "100000.00",
  },
  {
    reasonCode: "ADVANCE_PAYMENT",
    docType: "PAY",
    postingNature: "cash",
    autoPostLimit: "100000.00",
  },
  {
    reasonCode: "PAYMENT_REFUND",
    docType: "PAY",
    postingNature: "cash",
    autoPostLimit: "0.00",
  },
  {
    reasonCode: "SEC_DEPOSIT",
    docType: "DEP",
    postingNature: "deposit_movement",
    autoPostLimit: "50000.00",
  },
  {
    reasonCode: "DEP_REVERSE",
    docType: "DEP",
    postingNature: "deposit_movement",
    autoPostLimit: "0.00",
  },
  {
    reasonCode: "DEP_REFUND",
    docType: "DEP",
    postingNature: "deposit_movement",
    autoPostLimit: "0.00",
  },
  {
    reasonCode: "GOODWILL_CREDIT",
    docType: "CRN",
    postingNature: "revenue_adj",
    autoPostLimit: "1000.00",
  },
  {
    reasonCode: "MANUAL_CHARGE",
    docType: "DBN",
    postingNature: "revenue",
    autoPostLimit: "10000.00",
  },
  {
    reasonCode: "BAD_DEBT_WRITEOFF",
    docType: "ADJ",
    postingNature: "write_off",
    autoPostLimit: "0.00",
  },
  {
    reasonCode: "ROUNDING_ADJ",
    docType: "ADJ",
    postingNature: "rounding",
    autoPostLimit: "10.00",
  },
];

export async function seedReasonCodes(db: Database): Promise<void> {
  for (const entry of REASON_CODE_ENTRIES) {
    const [existing] = await db
      .select({ reasonCode: reasonCode.reasonCode })
      .from(reasonCode)
      .where(eq(reasonCode.reasonCode, entry.reasonCode))
      .limit(1);

    if (existing) {
      logger.info(`reason_code already exists, skipping: ${entry.reasonCode}`);
      continue;
    }

    await db.insert(reasonCode).values({
      reasonCode: entry.reasonCode,
      docType: entry.docType,
      postingNature: entry.postingNature,
      autoPostLimit: entry.autoPostLimit,
      state: "active",
      lastEditedBy: null,
    });
    logger.info(`created reason_code: ${entry.reasonCode}`);
  }
}
