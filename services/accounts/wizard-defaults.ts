import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import type { SetWizardDefaultsInput } from "@/validation/accounts/wizard-defaults.schema";

const CONFIG_GROUP = "accounts";

export interface WizardDefaultsFull {
  defaultBillCycleId: string | null;
  defaultCurrency: string | null;
  defaultCreditLimit: string | null;
  // Config row IDs needed by setWizardDefaults.
  _billCycleConfigId: string;
  _currencyConfigId: string;
  _creditLimitConfigId: string;
}

export type SetWizardDefaultsResult =
  | { ok: true }
  | { ok: false; code: "CONFIG_NOT_FOUND" };

export async function getWizardDefaultsFull(): Promise<WizardDefaultsFull> {
  const allRows = await systemConfigRepository.findAllNonSecret(db);
  const rows = allRows.filter((r) => r.configGroup === CONFIG_GROUP);

  const find = (key: string) => rows.find((r) => r.configKey === key);

  const billCycleRow = find("ACCOUNTS_DEFAULT_BILL_CYCLE");
  const currencyRow = find("ACCOUNTS_DEFAULT_CURRENCY");
  const creditLimitRow = find("ACCOUNTS_DEFAULT_CREDIT_LIMIT");

  if (!billCycleRow || !currencyRow || !creditLimitRow) {
    throw new Error(
      "wizard-defaults: one or more accounts config rows are missing — run db:seed-accounts",
    );
  }

  return {
    defaultBillCycleId: billCycleRow.configValue ?? null,
    defaultCurrency: currencyRow.configValue ?? null,
    defaultCreditLimit: creditLimitRow.configValue ?? null,
    _billCycleConfigId: billCycleRow.configId,
    _currencyConfigId: currencyRow.configId,
    _creditLimitConfigId: creditLimitRow.configId,
  };
}

export async function setWizardDefaults(
  input: SetWizardDefaultsInput,
  actorId: string,
): Promise<SetWizardDefaultsResult> {
  let current: WizardDefaultsFull;
  try {
    current = await getWizardDefaultsFull();
  } catch {
    return { ok: false, code: "CONFIG_NOT_FOUND" };
  }

  const beforeData = {
    defaultBillCycleId: current.defaultBillCycleId,
    defaultCreditLimit: current.defaultCreditLimit,
  };

  await db.transaction(async (tx) => {
    await systemConfigRepository.updateValue(
      tx,
      current._billCycleConfigId,
      input.defaultBillCycleId,
      actorId,
    );
    await systemConfigRepository.updateValue(
      tx,
      current._creditLimitConfigId,
      input.defaultCreditLimit ?? null,
      actorId,
    );
    await insertAuditEvent(tx, {
      eventType: "WIZARD_DEFAULTS_CHANGED",
      actorUserId: actorId,
      targetEntity: "system_config",
      targetId: null,
      beforeData,
      afterData: {
        defaultBillCycleId: input.defaultBillCycleId,
        defaultCreditLimit: input.defaultCreditLimit ?? null,
      },
    });
  });

  return { ok: true };
}
