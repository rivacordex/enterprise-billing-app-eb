import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import { logger } from "@/lib/logger";
import { glAccount, glMapping } from "@/db/schema/billing/catalogs";

interface GlMappingSeed {
  selectorType: "ledger_role" | "system_account";
  selector: string;
  currency: string | null;
  refGlCode: string;
}

// Role rules (`currency: null` — all currencies) + system-account rules
// (`currency: 'MYR'`) — ac03-spec §2.4. The three role rules are what make
// `gl_resolution_view` cover future `ban.*`/`fa.*` accounts with zero
// per-account mapping rows (V5's "after onboarding" half).
const GL_MAPPING_SEEDS: GlMappingSeed[] = [
  {
    selectorType: "ledger_role",
    selector: "receivables",
    currency: null,
    refGlCode: "1200",
  },
  {
    selectorType: "ledger_role",
    selector: "unapplied_cash",
    currency: null,
    refGlCode: "2300",
  },
  {
    selectorType: "ledger_role",
    selector: "deposits",
    currency: null,
    refGlCode: "2400",
  },
  {
    selectorType: "system_account",
    selector: "sys.revenue.MYR",
    currency: "MYR",
    refGlCode: "4000",
  },
  {
    selectorType: "system_account",
    selector: "sys.revenue_adj.MYR",
    currency: "MYR",
    refGlCode: "4090",
  },
  {
    selectorType: "system_account",
    selector: "sys.write_off.MYR",
    currency: "MYR",
    refGlCode: "6100",
  },
  {
    selectorType: "system_account",
    selector: "sys.rounding.MYR",
    currency: "MYR",
    refGlCode: "6900",
  },
  {
    selectorType: "system_account",
    selector: "sys.tax_payable.MYR",
    currency: "MYR",
    refGlCode: "2200",
  },
  {
    selectorType: "system_account",
    selector: "sys.cash.MYR",
    currency: "MYR",
    refGlCode: "1050",
  },
];

export async function seedGlMappings(tx: Database): Promise<void> {
  for (const seed of GL_MAPPING_SEEDS) {
    const [target] = await tx
      .select({ isPostable: glAccount.isPostable })
      .from(glAccount)
      .where(eq(glAccount.glCode, seed.refGlCode))
      .limit(1);
    if (!target) {
      throw new Error(
        `gl_mapping seed '${seed.selector}' references unknown gl_code '${seed.refGlCode}'.`,
      );
    }
    // A mapping to a summary node is a seed bug the test catches (§2.4).
    if (!target.isPostable) {
      throw new Error(
        `gl_mapping seed '${seed.selector}' -> '${seed.refGlCode}' targets a non-postable (summary) GL code.`,
      );
    }

    const [existing] = await tx
      .select({ glMappingId: glMapping.glMappingId })
      .from(glMapping)
      .where(
        and(
          eq(glMapping.selectorType, seed.selectorType),
          eq(glMapping.selector, seed.selector),
          seed.currency === null
            ? isNull(glMapping.currency)
            : eq(glMapping.currency, seed.currency),
        ),
      )
      .limit(1);
    if (existing) {
      continue;
    }

    await tx.insert(glMapping).values({
      selectorType: seed.selectorType,
      selector: seed.selector,
      currency: seed.currency,
      refGlCode: seed.refGlCode,
      lastEditedBy: null,
    });
  }
  logger.info("GL mappings seeded.", { count: GL_MAPPING_SEEDS.length });
}
