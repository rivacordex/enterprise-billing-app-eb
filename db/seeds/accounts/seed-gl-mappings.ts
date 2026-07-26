import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import { glAccount, glMapping } from "@/db/schema/billing/catalogs";
import { logger } from "@/lib/logger";

interface MappingEntry {
  selectorType: "ledger_role" | "system_account";
  selector: string;
  currency: string | null;
  refGlCode: string;
}

// Spec §2.4 / plan §2. Role selectors use currency = NULL (all currencies);
// system-account selectors carry MYR. Nine rows total.
const MAPPING_ENTRIES: MappingEntry[] = [
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

export async function seedGlMappings(db: Database): Promise<void> {
  for (const entry of MAPPING_ENTRIES) {
    // Assert target is postable — a non-postable target is a seed bug (spec §2.4).
    const [target] = await db
      .select({ isPostable: glAccount.isPostable })
      .from(glAccount)
      .where(eq(glAccount.glCode, entry.refGlCode))
      .limit(1);
    if (!target) {
      throw new Error(
        `seedGlMappings: target gl_code '${entry.refGlCode}' not found — seed-coa must run first`,
      );
    }
    if (!target.isPostable) {
      throw new Error(
        `seedGlMappings: target gl_code '${entry.refGlCode}' is not postable — seed bug (spec §2.4)`,
      );
    }

    const currencyCondition =
      entry.currency !== null
        ? eq(glMapping.currency, entry.currency)
        : isNull(glMapping.currency);

    const [existing] = await db
      .select({ id: glMapping.glMappingId })
      .from(glMapping)
      .where(
        and(
          eq(glMapping.selectorType, entry.selectorType),
          eq(glMapping.selector, entry.selector),
          currencyCondition,
        ),
      )
      .limit(1);

    if (existing) {
      logger.info(
        `gl_mapping already exists, skipping: ${entry.selectorType}/${entry.selector}`,
      );
      continue;
    }

    await db.insert(glMapping).values({
      selectorType: entry.selectorType,
      selector: entry.selector,
      currency: entry.currency,
      refGlCode: entry.refGlCode,
      lastEditedBy: null,
    });
    logger.info(
      `created gl_mapping: ${entry.selectorType}/${entry.selector} → ${entry.refGlCode}`,
    );
  }
}
