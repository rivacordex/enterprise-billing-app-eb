import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { logger } from "@/lib/logger";
import { glAccount } from "@/db/schema/billing/catalogs";

interface GlAccountSeed {
  glCode: string;
  name: string;
  accountClass: "asset" | "liability" | "equity" | "revenue" | "expense";
  normalBalance: "debit" | "credit";
  parentGlCode: string | null;
  isPostable: boolean;
}

// Chart of Accounts (ac03-spec §2.3, Q26) — minimal set covering every plan
// scenario. Summary nodes (1000, 2000) are `is_postable = false`; every leaf
// is `true`. `normal_balance`: debit for assets/expenses, credit for
// liabilities/revenue (§2.3). Parents must be inserted before children
// (`parent_gl_code` self-FK, `onDelete: restrict`).
const GL_ACCOUNT_SEEDS: GlAccountSeed[] = [
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
];

export async function seedChartOfAccounts(tx: Database): Promise<void> {
  // Summary nodes first (1000, 2000 have `parentGlCode: null` so ordering
  // among themselves doesn't matter), then leaves — `GL_ACCOUNT_SEEDS` is
  // already declared parent-before-child.
  for (const seed of GL_ACCOUNT_SEEDS) {
    const [existing] = await tx
      .select({ glCode: glAccount.glCode })
      .from(glAccount)
      .where(eq(glAccount.glCode, seed.glCode))
      .limit(1);
    if (existing) {
      continue;
    }
    await tx.insert(glAccount).values({
      glCode: seed.glCode,
      name: seed.name,
      accountClass: seed.accountClass,
      normalBalance: seed.normalBalance,
      parentGlCode: seed.parentGlCode,
      isPostable: seed.isPostable,
      lastEditedBy: null,
    });
  }
  logger.info("Chart of Accounts seeded.", { count: GL_ACCOUNT_SEEDS.length });
}
