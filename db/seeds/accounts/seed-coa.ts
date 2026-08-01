import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { glAccount } from "@/db/schema/billing/catalogs";
import { logger } from "@/lib/logger";

interface CoaEntry {
  glCode: string;
  name: string;
  accountClass: "asset" | "liability" | "equity" | "revenue" | "expense";
  normalBalance: "debit" | "credit";
  parentGlCode: string | null;
  isPostable: boolean;
}

// Spec §2.3 / plan §2. Parents listed before children because of the
// self-referential FK on parent_gl_code.
const COA_ENTRIES: CoaEntry[] = [
  {
    glCode: "1000",
    name: "Current Assets",
    accountClass: "asset",
    normalBalance: "debit",
    parentGlCode: null,
    isPostable: false,
  },
  {
    glCode: "2000",
    name: "Current Liabilities",
    accountClass: "liability",
    normalBalance: "credit",
    parentGlCode: null,
    isPostable: false,
  },
  {
    glCode: "4000",
    name: "Service Revenue",
    accountClass: "revenue",
    normalBalance: "credit",
    parentGlCode: null,
    isPostable: true,
  },
  {
    glCode: "4090",
    name: "Revenue Adjustments",
    accountClass: "revenue",
    normalBalance: "credit",
    parentGlCode: null,
    isPostable: true,
  },
  {
    glCode: "6100",
    name: "Bad Debt Expense",
    accountClass: "expense",
    normalBalance: "debit",
    parentGlCode: null,
    isPostable: true,
  },
  {
    glCode: "6900",
    name: "Rounding Differences",
    accountClass: "expense",
    normalBalance: "debit",
    parentGlCode: null,
    isPostable: true,
  },
  // Children inserted after their parents.
  {
    glCode: "1050",
    name: "Cash Clearing",
    accountClass: "asset",
    normalBalance: "debit",
    parentGlCode: "1000",
    isPostable: true,
  },
  {
    glCode: "1200",
    name: "Accounts Receivable",
    accountClass: "asset",
    normalBalance: "debit",
    parentGlCode: "1000",
    isPostable: true,
  },
  {
    glCode: "2200",
    name: "SST Payable",
    accountClass: "liability",
    normalBalance: "credit",
    parentGlCode: "2000",
    isPostable: true,
  },
  {
    glCode: "2300",
    name: "Unapplied Customer Receipts",
    accountClass: "liability",
    normalBalance: "credit",
    parentGlCode: "2000",
    isPostable: true,
  },
  {
    glCode: "2400",
    name: "Customer Deposits",
    accountClass: "liability",
    normalBalance: "credit",
    parentGlCode: "2000",
    isPostable: true,
  },
];

export async function seedCoa(db: Database): Promise<void> {
  for (const entry of COA_ENTRIES) {
    const [existing] = await db
      .select({ glCode: glAccount.glCode })
      .from(glAccount)
      .where(eq(glAccount.glCode, entry.glCode))
      .limit(1);

    if (existing) {
      logger.info(`gl_account already exists, skipping: ${entry.glCode}`);
      continue;
    }

    await db.insert(glAccount).values({
      glCode: entry.glCode,
      name: entry.name,
      accountClass: entry.accountClass,
      normalBalance: entry.normalBalance,
      parentGlCode: entry.parentGlCode,
      isPostable: entry.isPostable,
      state: "active",
      lastEditedBy: null,
    });
    logger.info(`created gl_account: ${entry.glCode} ${entry.name}`);
  }
}
