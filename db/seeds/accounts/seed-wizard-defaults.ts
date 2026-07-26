import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { systemConfig } from "@/db/schema/system-config";
import { logger } from "@/lib/logger";

const CONFIG_GROUP = "accounts";

// Spec §2.6 — wizard defaults read by ac04 and editable in ac15. The credit-
// limit key is seeded with a null value (no pre-fill); ac04 reads the key and
// falls back gracefully when it is absent or null.
async function upsertConfig(
  db: Database,
  key: string,
  value: string | null,
  description: string,
): Promise<void> {
  const [existing] = await db
    .select({ configId: systemConfig.configId })
    .from(systemConfig)
    .where(
      and(
        eq(systemConfig.configGroup, CONFIG_GROUP),
        eq(systemConfig.configVersion, 1),
        eq(systemConfig.configKey, key),
      ),
    )
    .limit(1);

  if (existing) {
    logger.info(
      `system_config already exists, skipping: ${CONFIG_GROUP}/${key}`,
    );
    return;
  }

  await db.insert(systemConfig).values({
    configGroup: CONFIG_GROUP,
    configVersion: 1,
    configKey: key,
    configValue: value,
    description,
    isSecret: false,
    status: "ACTIVE",
    modifiedBy: null,
  });
  logger.info(
    `created system_config: ${CONFIG_GROUP}/${key} = ${value ?? "null"}`,
  );
}

export async function seedWizardDefaults(
  db: Database,
  defaultBillCycleId: string,
): Promise<void> {
  await upsertConfig(
    db,
    "ACCOUNTS_DEFAULT_BILL_CYCLE",
    defaultBillCycleId,
    "Default bill cycle assigned to new billing accounts in the onboarding wizard.",
  );
  await upsertConfig(
    db,
    "ACCOUNTS_DEFAULT_CURRENCY",
    "MYR",
    "Default currency for new financial accounts (Q12 — single MYR family this phase).",
  );
  await upsertConfig(
    db,
    "ACCOUNTS_DEFAULT_CREDIT_LIMIT",
    null,
    "Default credit limit pre-fill for new financial accounts; null = no pre-fill (manual per customer).",
  );
}
