import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { logger } from "@/lib/logger";
import { systemConfig } from "@/db/schema/system-config";

const CONFIG_GROUP = "accounts";

interface WizardDefaultSeed {
  configKey: string;
  configValue: string | null;
  description: string;
}

// Onboarding-wizard defaults (ac03-spec §2.6 note) — the minimal config set
// ac04's Q2 wizard reads. `ACCOUNTS_DEFAULT_CREDIT_LIMIT` seeds `null` (no
// pre-fill): the open "default credit limit" item resolves as manual
// per-customer, optionally pre-filled from this key — only the seeded value
// changes if a hard default is wanted later, not the shape.
function buildWizardDefaultSeeds(
  defaultBillCycleId: string,
): WizardDefaultSeed[] {
  return [
    {
      configKey: "ACCOUNTS_DEFAULT_BILL_CYCLE",
      configValue: defaultBillCycleId,
      description:
        "Default bill cycle pre-selected in the customer-onboarding wizard.",
    },
    {
      configKey: "ACCOUNTS_DEFAULT_CURRENCY",
      configValue: "MYR",
      description:
        "Read-only default currency for new FA/BAN accounts (Q12 — single-currency phase).",
    },
    {
      configKey: "ACCOUNTS_DEFAULT_CREDIT_LIMIT",
      configValue: null,
      description:
        "Optional credit-limit pre-fill for the onboarding wizard; null means no pre-fill (manual per-customer).",
    },
  ];
}

export async function seedWizardDefaults(
  tx: Database,
  defaultBillCycleId: string,
): Promise<void> {
  const seeds = buildWizardDefaultSeeds(defaultBillCycleId);

  for (const seed of seeds) {
    const [existing] = await tx
      .select({ configId: systemConfig.configId })
      .from(systemConfig)
      .where(
        and(
          eq(systemConfig.configGroup, CONFIG_GROUP),
          eq(systemConfig.configKey, seed.configKey),
        ),
      )
      .limit(1);
    if (existing) {
      continue;
    }

    await tx.insert(systemConfig).values({
      configGroup: CONFIG_GROUP,
      configVersion: 1,
      configKey: seed.configKey,
      configValue: seed.configValue,
      description: seed.description,
      isSecret: false,
      status: "ACTIVE",
      modifiedBy: null,
    });
  }
  logger.info("Accounts wizard-default config seeded.", {
    count: seeds.length,
  });
}
